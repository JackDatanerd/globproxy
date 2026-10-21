import { appUrl } from '@/lib/appUrl'
import { createAdminClient } from '@/lib/supabase/server'
import { syncAllUsage } from '@/lib/usageSync'
import { computeStockStatus } from '@/lib/stockStatus'
import { sendEmail, escapeHtml } from '@/lib/email'
import { runWebhookRetries, runBandwidthThresholdWebhooks, pruneIntegrationData } from '@/lib/webhooks'
import { warnExpiringApiKeys } from '@/lib/apiKeyExpiry'
import { provisionPendingCredentials, reconcileLimitSync, flagStalledPending } from '@/lib/credentials'
import { runConfiguredBenchmark } from '@/lib/networkProbe'
import { chargeAuthorization, generateReference, verifyTransaction, paymentMismatchReason } from '@/lib/paystack'
import { activateBandwidth, retryPostCredit } from '@/lib/bandwidth'
import { alertAdminPayment } from '@/lib/paymentAlerts'
import { failPendingOrder } from '@/lib/orderFailure'
import { flushSecurityNotices } from '@/lib/securityEvents'
import { REFERRAL_GB_BONUS } from '@/lib/referrals'
import { findReportedError, recordCronRun, checkCronFreshness, claimCronLock, releaseCronLock } from '@/lib/cronHealth'
import { NextResponse } from 'next/server'

// Secured with the CRON_SECRET Worker secret (pushed by .github/workflows/deploy.yml).
// Invoked by custom-worker.ts's scheduled() handler; every run is recorded in
// cron_task_runs (lib/cronHealth.ts) so failures and silence are visible.
function validateCron(req: Request): boolean {
  const secret = req.headers.get('x-cron-secret') ?? ''
  const expected = process.env.CRON_SECRET ?? ''
  if (!expected) return false
  const crypto = require('crypto')
  const a = Buffer.from(secret)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// Usage-sync freshness watchdog. Deliberately called from the 'stock'
// task rather than living inside the 'usage' task itself — cron-job.org
// schedules each task as its own separate job, and the whole point is to
// notice if the 'usage' job specifically stops firing (or starts failing)
// without anyone watching it directly. This already happened once (see
// migration 0010's history): cron-job.org auto-disabled the usage job
// after 26 consecutive failures, and gb_used silently went stale
// platform-wide with nothing in-app to surface it. A NULL timestamp
// (never synced yet — e.g. right after a fresh deploy/migration) is
// treated as "unknown" and skipped rather than alerted, to avoid a false
// alarm before the first sync has had a chance to run.
const USAGE_SYNC_STALE_THRESHOLD_MS = 20 * 60 * 1000 // 20 min — ~4x the ~5 min cadence

async function checkUsageSyncFreshness(supabase: Awaited<ReturnType<typeof createAdminClient>>) {
  const { data: rows } = await supabase
    .from('platform_settings')
    .select('key, value')
    .in('key', ['usage_last_synced_at', 'usage_sync_stale_alerted_at'])
  const settings = Object.fromEntries((rows ?? []).map(r => [r.key, r.value]))

  if (!settings.usage_last_synced_at) return { stale: false, reason: 'never_synced' }

  const ageMs = Date.now() - new Date(settings.usage_last_synced_at).getTime()
  const stale = ageMs > USAGE_SYNC_STALE_THRESHOLD_MS

  if (!stale) {
    // Recovered — clear any prior alert flag so a future staleness re-alerts.
    if (settings.usage_sync_stale_alerted_at) {
      await supabase.from('platform_settings').delete().eq('key', 'usage_sync_stale_alerted_at')
    }
    return { stale: false }
  }

  // Already alerted for this ongoing incident — don't spam on every
  // 'stock' tick until it recovers.
  if (settings.usage_sync_stale_alerted_at) return { stale: true, already_alerted: true }

  await sendEmail({
    to: process.env.ADMIN_EMAIL!,
    subject: `[USAGE SYNC STALE] Last successful sync was ${Math.round(ageMs / 60000)} min ago`,
    html: `<p>Usage-sync (the 'usage' cron task) hasn't completed successfully in over
           ${Math.round(USAGE_SYNC_STALE_THRESHOLD_MS / 60000)} minutes.</p>
           <p><strong>Last known good sync:</strong> ${settings.usage_last_synced_at}</p>
           <p>gb_used and account balances are going stale until this recovers — check
           whether the external cron trigger for the 'usage' task is still firing.</p>`,
  })
  await supabase.from('platform_settings')
    .upsert({ key: 'usage_sync_stale_alerted_at', value: new Date().toISOString() }, { onConflict: 'key' })

  return { stale: true, already_alerted: false }
}

// ── Stock check ──────────────────────────────────────────────────
async function runStockCheck() {
  const supabase = await createAdminClient()

  // The usage-sync watchdog runs FIRST and on its own. It used to sit after
  // computeStockStatus, which calls the upstream provider: during exactly the
  // outage that makes usage sync stale (provider down, key revoked), the stock
  // read threw first and the watchdog never ran — silence at the moment an
  // alert matters most.
  let syncHealth: Awaited<ReturnType<typeof checkUsageSyncFreshness>> | { error: string }
  try { syncHealth = await checkUsageSyncFreshness(supabase) }
  catch (e) { console.error('[stock] usage-sync freshness check failed', e); syncHealth = { error: 'freshness_check_failed' } }

  let stock: Awaited<ReturnType<typeof computeStockStatus>>
  try {
    stock = await computeStockStatus(supabase)
  } catch (e) {
    // Provider API unreachable / rejecting us. Nothing in the app alerted on
    // this before (only the log). Email once, remind every 24h while it
    // persists, and return 200 so the cron job isn't auto-disabled by the
    // external scheduler after repeated failures.
    console.error('[stock] upstream stock read failed', e)
    const { data: row } = await supabase
      .from('platform_settings').select('value').eq('key', 'upstream_api_alert_at').maybeSingle()
    const last = row?.value ? new Date(row.value).getTime() : 0
    if (!last || Date.now() - last > 24 * 60 * 60 * 1000) {
      if (process.env.ADMIN_EMAIL) {
        await sendEmail({
          to: process.env.ADMIN_EMAIL,
          subject: '[UPSTREAM API FAILING] Could not read proxy provider stock',
          html: `<p>The hourly stock check could not read the proxy provider's account balance, so stock and
                 exposure are unknown. Usage sync and provisioning depend on the same API — check the provider
                 status page and that the reseller API key is still valid.</p>
                 <p style="color:#666">Error (also in the worker logs): <code>${escapeHtml(String((e as any)?.message ?? e).slice(0, 300))}</code></p>`,
        }).catch((err) => console.error('[stock] failure alert email failed', err))
      }
      await supabase.from('platform_settings')
        .upsert({ key: 'upstream_api_alert_at', value: new Date().toISOString() }, { onConflict: 'key' })
    }
    // `error` makes the cron heartbeat (lib/cronHealth) record this run as failed, so it
    // also shows on the admin cron-health panel — not only in the alert email.
    return { action: 'stock_unavailable', error: 'upstream_stock_unavailable', usage_sync: syncHealth }
  }
  // Recovered — clear the failure flag so the next outage alerts immediately.
  await supabase.from('platform_settings').delete().eq('key', 'upstream_api_alert_at')

  await supabase.from('platform_settings')
    .upsert({ key: 'geonode_stock', value: JSON.stringify(stock) }, { onConflict: 'key' })

  // Two distinct alert conditions — either can fire independently:
  // 1. Exposure alert: stock can't cover what's currently promised to
  //    customers if they all drew down at once. This is the one that
  //    actually matters for a usage-based model.
  // 2. Absolute floor alert: stock is just low in absolute terms, kept as a
  //    simple backstop regardless of exposure math.
  //
  // The floor itself: /admin/settings lets an admin set auto_reload_enabled
  // + auto_reload_threshold_gb in platform_settings, but until now nothing
  // ever read those back — STOCK_ALERT_THRESHOLD was the only value in
  // effect and the panel was pure UI theater. When auto_reload is enabled,
  // its threshold now takes over from the env var. auto_reload_amount_gb is
  // still not consumed anywhere — there's no automatic Geonode purchase
  // pipeline in this codebase yet, so "auto-reload" today only means "alert
  // me earlier," not "buy more automatically." That's a separate feature.
  const { data: settingsRows } = await supabase
    .from('platform_settings')
    .select('key, value')
    .in('key', ['auto_reload_enabled', 'auto_reload_threshold_gb'])
  const settings = Object.fromEntries((settingsRows ?? []).map(r => [r.key, r.value]))
  const autoReloadEnabled = settings.auto_reload_enabled === 'true'
  const threshold = autoReloadEnabled && settings.auto_reload_threshold_gb
    ? Number(settings.auto_reload_threshold_gb)
    : Number(process.env.STOCK_ALERT_THRESHOLD ?? 10)
  const exposureBreach = !stock.covered
  const floorBreach = stock.available_gb <= threshold

  // De-dupe: this task runs hourly, and the condition used to re-email the
  // admin on EVERY tick for as long as it held (the usage-staleness alert
  // above already de-dupes; this didn't). Now: one email when a condition
  // begins (or changes kind), a reminder at most every 24h while it
  // persists, and the flag clears when stock recovers.
  const breachKind = exposureBreach ? 'exposure' : floorBreach ? 'floor' : null
  const { data: alertRow } = await supabase
    .from('platform_settings').select('value').eq('key', 'stock_alert_state').maybeSingle()
  let prevAlert: { kind?: string; at?: string } = {}
  try { prevAlert = JSON.parse(alertRow?.value ?? '{}') } catch { /* reset */ }

  if (!breachKind) {
    if (alertRow) await supabase.from('platform_settings').delete().eq('key', 'stock_alert_state')
    return { action: 'ok', ...stock, usage_sync: syncHealth }
  }

  const REMINDER_MS = 24 * 60 * 60 * 1000
  const alreadyAlerted = prevAlert.kind === breachKind && prevAlert.at &&
    Date.now() - new Date(prevAlert.at).getTime() < REMINDER_MS
  if (alreadyAlerted) {
    return { action: 'alert_suppressed', ...stock, usage_sync: syncHealth }
  }

  const subject = exposureBreach
    ? `[EXPOSURE ALERT] Stock (${stock.available_gb.toFixed(1)}GB) can't cover unallocated + pending customer GB (${stock.exposure_gb.toFixed(1)}GB)`
    : `[LOW STOCK] Geonode bandwidth: ${stock.available_gb.toFixed(1)}GB remaining`
  await sendEmail({
    to: process.env.ADMIN_EMAIL!,
    subject,
    html: `<p><strong>Available to allocate:</strong> ${stock.available_gb.toFixed(1)}GB of ${stock.total_gb.toFixed(1)}GB total</p>
           <p><strong>Customer balances not yet allocated to a session:</strong> ${stock.unallocated_balances_gb.toFixed(1)}GB</p>
           <p><strong>Sessions waiting to be provisioned:</strong> ${stock.pending_allocated_gb.toFixed(1)}GB</p>
           <p><strong>Exposure (the two above):</strong> ${stock.exposure_gb.toFixed(1)}GB</p>
           <p style="color:#666">Already inside live sessions: ${stock.committed_unused_gb.toFixed(1)}GB unused of ${stock.total_allocated_gb.toFixed(1)}GB allocated — already deducted from Geonode's available figure, so not counted as exposure.</p>
           ${exposureBreach ? '<p style="color:#e24b4a"><strong>If customers turned all their unallocated balance into sessions right now, you would run short.</strong></p>' : ''}
           <p><a href="${appUrl()}/admin/settings">Go to Admin Panel →</a></p>`,
  })
  await supabase.from('platform_settings')
    .upsert({ key: 'stock_alert_state', value: JSON.stringify({ kind: breachKind, at: new Date().toISOString() }) }, { onConflict: 'key' })
  return { action: 'alert_sent', ...stock, usage_sync: syncHealth }
}

// ── Usage sync ───────────────────────────────────────────────────
// Implementation lives in lib/usageSync.ts — shared with the admin
// "sync now" button (app/api/admin/sync-usage) so there is exactly one
// place that decides how gb_used gets reconciled from Geonode, not two
// that can quietly diverge.
// syncAllUsage() THROWS when Geonode's sub-user listing is incomplete (so an
// outage can't masquerade as a healthy sync). In the */5 chain a non-OK task
// stops every task after it (custom-worker.ts), and 'provision' + 'webhooks'
// run after 'usage' — webhook delivery retries and threshold events have
// nothing to do with Geonode and must keep running during its outage. So the
// cron wrapper logs the failure and reports it in the body instead; the
// freshness marker is deliberately NOT stamped, which is what the staleness
// watchdog in 'stock' alerts on. (The admin "sync now" button still surfaces
// the error as a 500.)
async function runUsageSync() {
  try {
    return await syncAllUsage()
  } catch (e: any) {
    console.error('[cron usage] sync did not complete:', e)
    return { ok: false, error: String(e?.message ?? e) }
  }
}

// ── User bandwidth alerts ─────────────────────────────────────────
// Each account only ever gets ONE email per threshold (80%, 95%) until
// a top-up moves them back below that threshold, at which point the
// corresponding alerted_*_at flag is cleared and they can be alerted
// again on the next approach. Previously there was no de-dupe at all,
// so any account sitting above a threshold got a fresh email on every
// cron run (e.g. every 15 minutes) indefinitely.
async function runBandwidthAlerts() {
  const supabase = await createAdminClient()
  const { data: accounts } = await supabase
    .from('bandwidth_accounts')
    .select('user_id, total_gb, used_gb, available_gb, alerted_80_at, alerted_95_at')
    .gt('total_gb', 0)

  let sent = 0
  for (const acc of accounts ?? []) {
    if (!acc.total_gb) continue
    // Was (used_gb / total_gb) — but the email below reports available_gb,
    // which also subtracts allocated_gb (GB reserved into credentials, not
    // yet consumed). An account with heavy allocated_gb could have
    // available_gb near zero while used_gb stayed low, so it would never
    // cross this threshold even though it effectively can't create new
    // credentials. Basing pct on available_gb keeps the trigger consistent
    // with what the account can actually still do.
    const pct = ((acc.total_gb - acc.available_gb) / acc.total_gb) * 100

    // Below 80% — clear any stale alert flags so a future approach re-alerts.
    if (pct < 80) {
      if (acc.alerted_80_at || acc.alerted_95_at) {
        await supabase.from('bandwidth_accounts')
          .update({ alerted_80_at: null, alerted_95_at: null })
          .eq('user_id', acc.user_id)
      }
      continue
    }

    const { data: profile } = await supabase
      .from('profiles').select('email, full_name, referral_code, affiliate_status').eq('id', acc.user_id).single()
    if (!profile?.email) continue

    const firstName = escapeHtml(profile.full_name?.split(' ')[0]) || 'there'
    const avail = acc.available_gb
    const referralLine = profile.referral_code
      ? `<p style="margin-top:16px;font-size:13px;color:#666;">${profile.affiliate_status === 'approved'
           ? 'Tip: share your affiliate link and earn commission on every order —'
           : `Tip: refer a friend and you both get ${REFERRAL_GB_BONUS}GB free —`}
           <a href="${appUrl()}/r/${profile.referral_code}">your link</a>.</p>`
      : ''

    if (pct >= 95 && !acc.alerted_95_at) {
      await sendEmail({
        to: profile.email,
        subject: `🚨 Only ${avail.toFixed(1)}GB remaining — GlobProxy`,
        html: `<p>Hi ${firstName}, you've used ${pct.toFixed(0)}% of your bandwidth. Only ${avail.toFixed(1)}GB remains.</p>
               <a href="${appUrl()}/dashboard/buy">Top up now →</a>
               ${referralLine}`,
      })
      // (The bandwidth_threshold_crossed WEBHOOK no longer fires from this
      // once-a-day email run — it has its own 5-minute task, see
      // runBandwidthThresholdWebhooks in lib/webhooks.ts.)
      await supabase.from('bandwidth_accounts')
        .update({ alerted_95_at: new Date().toISOString() })
        .eq('user_id', acc.user_id)
      sent++
    } else if (pct >= 80 && pct < 95 && !acc.alerted_80_at) {
      await sendEmail({
        to: profile.email,
        subject: `Heads up: ${avail.toFixed(1)}GB bandwidth remaining`,
        html: `<p>Hi ${firstName}, you've used ${pct.toFixed(0)}% of your bandwidth. ${avail.toFixed(1)}GB remains.</p>
               <a href="${appUrl()}/dashboard/buy">Buy more →</a>
               ${referralLine}`,
      })
      await supabase.from('bandwidth_accounts')
        .update({ alerted_80_at: new Date().toISOString() })
        .eq('user_id', acc.user_id)
      sent++
    }
  }
  return { alerts_sent: sent }
}

// ── Daily summary ─────────────────────────────────────────────────
async function runDailySummary() {
  const supabase = await createAdminClient()
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
  const today = new Date().toISOString().split('T')[0]

  const { data: orders } = await supabase.from('orders')
    .select('amount_usd, gb_amount, refunded_usd')
    .eq('payment_status', 'paid')
    .eq('is_canary', false) // canary's daily $0.50 test charge isn't real revenue
    .gte('paid_at', `${yesterday}T00:00:00Z`)
    .lt('paid_at', `${today}T00:00:00Z`)

  // Net of refunds issued so far (partial refunds keep status 'paid'), the same
  // basis as the admin Overview/Orders pages, so the email and the dashboard
  // agree.
  const keptShare = (o: { amount_usd: number; refunded_usd: number | null }) => {
    const amt = Number(o.amount_usd)
    return amt > 0 ? Math.max(amt - Number(o.refunded_usd ?? 0), 0) / amt : 1
  }
  const rev = orders?.reduce((s, o) => s + Number(o.amount_usd) * keptShare(o), 0) ?? 0
  const gb = orders?.reduce((s, o) => s + Number(o.gb_amount) * keptShare(o), 0) ?? 0

  const { count: newUsers } = await supabase.from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', `${yesterday}T00:00:00Z`)

  await sendEmail({
    to: process.env.ADMIN_EMAIL!,
    subject: `GlobProxy Daily Summary — ${yesterday}`,
    html: `<div style="font-family:sans-serif">
      <h2 style="color:#0057ff">Daily Summary — ${yesterday}</h2>
      <p><strong>Revenue (net of refunds):</strong> $${rev.toFixed(2)}</p>
      <p><strong>GB sold:</strong> ${gb.toFixed(1)} GB</p>
      <p><strong>Orders:</strong> ${orders?.length ?? 0}</p>
      <p><strong>New users:</strong> ${newUsers ?? 0}</p>
      <a href="${appUrl()}/admin">Open admin panel →</a>
    </div>`,
  })
  return { revenue: rev, gb_sold: gb, new_users: newUsers }
}

// ── Reconcile uncredited orders against Paystack ──────────────────
// Safety net for the webhook: if a charge.success never arrived or its
// processing failed, any order that isn't credited yet (pending, or locally
// cancelled/failed) is re-verified directly with Paystack and credited if the
// money really arrived. First look is ~5 min after creation, then at most
// hourly, for 3 days — bounded so abandoned checkouts don't cost Paystack
// calls forever. Never throws: it runs ahead of 'usage' in the same cron
// chain and a failure here must not block that.
async function runReconcile() {
  try {
    const supabase = await createAdminClient()
    const now = Date.now()
    const minAge = new Date(now - 5 * 60 * 1000).toISOString()
    const maxAge = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString()
    const recheck = new Date(now - 60 * 60 * 1000).toISOString()

    const { data: candidates, error } = await supabase.from('orders')
      .select('id, user_id, payment_status, amount_usd, gb_amount, paystack_reference, is_canary, pay_currency, pay_amount, created_at')
      .eq('bandwidth_credited', false)
      .in('payment_status', ['pending', 'cancelled', 'failed'])
      .not('paystack_reference', 'is', null)
      .lt('created_at', minAge)
      .gt('created_at', maxAge)
      .or(`reconcile_checked_at.is.null,reconcile_checked_at.lt.${recheck}`)
      .order('reconcile_checked_at', { ascending: true, nullsFirst: true })
      .limit(10)
    if (error) return { error: error.message }

    let recovered = 0, mismatched = 0, errors = 0, failed = 0
    for (const o of candidates ?? []) {
      let settled = true // whether to push the next look out by an hour
      try {
        const txn = await verifyTransaction(o.paystack_reference!)
        if (txn.status === 'success') {
          const mismatch = paymentMismatchReason(txn, o)
          if (mismatch) {
            mismatched++
            await alertAdminPayment('Reconcile: paid transaction does not match its order — NOT credited', {
              order_id: o.id, reference: o.paystack_reference, problem: mismatch,
            })
          } else {
            const result = await activateBandwidth({
              order_id: o.id, user_id: o.user_id, gb_amount: Number(o.gb_amount),
              paystack_reference: o.paystack_reference!, amount_usd: Number(o.amount_usd),
              is_canary: !!o.is_canary,
            })
            if (result.status === 'credited') {
              recovered++
              await alertAdminPayment('Reconcile recovered an uncredited payment', {
                order_id: o.id, reference: o.paystack_reference, previous_status: o.payment_status,
                amount_usd: o.amount_usd, gb: o.gb_amount,
              })
            } else if (result.status === 'error') {
              errors++
              settled = false // retry on the next run
            }
          }
        } else if (txn.status === 'failed' && o.payment_status === 'pending') {
          // Paystack documents no charge.failed webhook, so this is how a
          // decline normally becomes visible: record it, tell the customer and
          // the admin once. Only after 15 minutes, so a customer who is simply
          // retrying another card isn't emailed mid-checkout. A later success
          // on the same checkout is still credited (the claim accepts 'failed').
          const ageMs = Date.now() - Date.parse(o.created_at)
          if (ageMs >= 15 * 60 * 1000) {
            await failPendingOrder(supabase, o, txn.gateway_response ?? null, { source: 'reconcile', alertAdmin: true })
            failed++
          } else {
            settled = false // look again next run rather than waiting an hour
          }
        }
      } catch (e: any) {
        // A reference Paystack has never seen is a normal, permanent answer
        // for an abandoned checkout; anything else (outage, network) is
        // retried next run rather than deferred an hour.
        if (!/not found/i.test(String(e?.message))) { errors++; settled = false }
      }
      if (settled) {
        await supabase.from('orders').update({ reconcile_checked_at: new Date().toISOString() }).eq('id', o.id)
      }
    }
    return { checked: candidates?.length ?? 0, recovered, mismatched, errors, failed }
  } catch (e: any) {
    console.error('[reconcile] failed', e)
    return { error: e?.message ?? 'reconcile failed' }
  }
}

// ── Re-run the follow-ups of credited orders that didn't fully finish ─
// activateBandwidth() stamps orders.post_credit_done_at once credential
// activation + referral/affiliate crediting succeed (migration 0041).
// Unstamped credited orders are retried here — both steps are idempotent —
// for up to 3 days. (Credentials stuck in 'pending' are retried by the
// separate 'provision' task.)
async function runPostCreditRetry() {
  try {
    const supabase = await createAdminClient()
    const now = Date.now()
    const minAge = new Date(now - 3 * 60 * 1000).toISOString()
    const maxAge = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString()

    const { data: orders, error } = await supabase.from('orders')
      .select('id, user_id, gb_amount, amount_usd, is_canary')
      .eq('bandwidth_credited', true)
      .is('post_credit_done_at', null)
      .lt('paid_at', minAge)
      .gt('paid_at', maxAge)
      .order('paid_at', { ascending: true })
      .limit(10)
    if (error) return { error: error.message }

    let retried = 0, completed = 0
    for (const o of orders ?? []) {
      retried++
      if (await retryPostCredit(o)) completed++
    }

    // (Credentials stuck in 'pending' are no longer swept from here: the
    // dedicated 'provision' task below retries them with backoff and an
    // atomic claim, instead of fanning out per user once an hour.)

    return { retried, completed }
  } catch (e: any) {
    console.error('[post-credit retry] failed', e)
    return { error: e?.message ?? 'post-credit retry failed' }
  }
}

// ── Cleanup stale orders ──────────────────────────────────────────
async function runCleanup() {
  const supabase = await createAdminClient()
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: stale } = await supabase.from('orders')
    .select('id').eq('payment_status', 'pending').lt('created_at', cutoff)

  for (const o of stale ?? []) {
    // Conditional on the order STILL being pending and uncredited: this loop
    // runs for a while after the select above, and an order paid in that gap
    // (webhook / verify-payment) must never be overwritten with 'failed'.
    await supabase.from('orders').update({
      payment_status: 'failed',
      failure_reason: 'Abandoned — not paid within 24h',
      failed_at: new Date().toISOString(),
    }).eq('id', o.id).eq('payment_status', 'pending').eq('bandwidth_credited', false)
  }

  // Expired MFA "verified this browser" tokens (migration 0020). Already
  // functionally inert everywhere they're checked (every lookup filters
  // expires_at > now()) — this just keeps the table from growing
  // unbounded on a long-lived deployment, same reasoning as the stale
  // orders above.
  const { error: mfaErr } = await supabase.rpc('cleanup_expired_mfa_sessions')
  if (mfaErr) console.error('cleanup_expired_mfa_sessions failed:', mfaErr)

  // Aggregated CSP reports older than 30 days (migration 0059).
  const { error: cspErr } = await supabase.rpc('prune_csp_violations')
  if (cspErr) console.error('prune_csp_violations failed:', cspErr)

  // Webhook delivery log (14 days), API idempotency keys (24h), API request log (30 days).
  const pruned = await pruneIntegrationData().catch((e) => {
    console.error('pruneIntegrationData failed:', e)
    return { deliveries_pruned: false, idempotency_pruned: false, request_log_pruned: false }
  })

  // API keys expiring within 7 days: e-mail + api_key_expiring webhook, once each.
  const keyExpiry = await warnExpiringApiKeys().catch((e) => {
    console.error('warnExpiringApiKeys failed:', e)
    return { warned: 0 }
  })

  // Terminated ("hidden") sticky sessions are kept for a week, then purged:
  // nothing ever removed them, so they only accumulated (and count toward the
  // per-credential stored-session cap in migration 0059).
  const sessionCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { error: sessErr } = await supabase.from('proxy_sessions')
    .delete().not('terminated_at', 'is', null).lt('terminated_at', sessionCutoff)
  if (sessErr) console.error('terminated proxy_sessions purge failed:', sessErr)

  return { cleaned: stale?.length ?? 0, mfa_sessions_swept: !mfaErr, csp_pruned: !cspErr, sessions_purged: !sessErr, ...pruned, api_keys_expiry_warned: keyExpiry.warned }
}

// ── Security notices + audit-log retention (migration 0039) ──────────
// password_changed events are written by a database trigger however the
// password changed — including direct Supabase API calls that never touch
// our routes — so this sweep is what guarantees the owner is told. Events
// younger than 2 minutes are left alone so the request that caused them
// can send its own notice first (flushSecurityNotices claims each event
// before sending, so the two can't double-email anyway). Must never throw:
// it runs in the same */5 chain as 'usage', which stops at the first failure.
async function runSecurity() {
  let noticesSent = 0
  let purged: number | null = null
  try {
    noticesSent = await flushSecurityNotices(undefined, 2 * 60 * 1000)
  } catch (e) {
    console.error('[cron security] notice flush failed', e)
  }
  try {
    const supabase = await createAdminClient()
    const { data, error } = await supabase.rpc('cleanup_old_security_events')
    if (error) console.error('[cron security] cleanup_old_security_events failed', error)
    else purged = typeof data === 'number' ? data : null
  } catch (e) {
    console.error('[cron security] cleanup threw', e)
  }
  return { notices_sent: noticesSent, events_purged: purged }
}

// ── Canary payment (continuous end-to-end payment test) ────────────
// Charges a small real amount to a dedicated test account daily, using a
// saved Paystack authorization_code (captured by webhooks/paystack/route.ts
// the first time that account pays through the normal checkout) rather
// than a checkout page — nothing to click, so this can run unattended.
// A real charge.success/charge.failed still fires for it exactly like a
// normal customer payment, so the existing webhook logic (credit
// bandwidth, or mark failed + alert immediately) covers it unchanged.
// is_canary=true keeps it out of daily-summary revenue and the
// /admin/orders "is something broken" read.
//
// Configuration lives in platform_settings, not env vars, so it can be
// turned on/off and re-pointed at a different test account from SQL
// without a redeploy:
//   canary_user_id            — profiles.id of the dedicated test account
//   canary_authorization_code — set automatically after that account's
//                                first successful checkout (see webhook)
// Skips cleanly (never throws) if either is missing — same shape as
// runBenchmark's "not configured yet" skip below.
const CANARY_GB = 0.1
const CANARY_AMOUNT_USD = 0.5 // Paystack's practical USD minimum — raise if declined for being too small

async function runCanary() {
  const supabase = await createAdminClient()
  const { data: settings } = await supabase
    .from('platform_settings').select('key, value')
    .in('key', ['canary_user_id', 'canary_authorization_code'])
  const cfg = Object.fromEntries((settings ?? []).map(r => [r.key, r.value]))

  if (!cfg.canary_user_id || !cfg.canary_authorization_code) {
    return { skipped: true, reason: 'not_configured' }
  }

  const { data: profile } = await supabase
    .from('profiles').select('email').eq('id', cfg.canary_user_id).single()
  if (!profile?.email) return { skipped: true, reason: 'canary_user_not_found' }

  const reference = generateReference()
  const { data: order, error: orderErr } = await supabase.from('orders').insert({
    user_id: cfg.canary_user_id,
    gb_amount: CANARY_GB,
    amount_usd: CANARY_AMOUNT_USD,
    payment_method: 'paystack',
    payment_status: 'pending',
    paystack_reference: reference,
    is_canary: true,
  }).select().single()
  if (orderErr || !order) throw new Error(`canary order insert failed: ${orderErr?.message}`)

  try {
    const result = await chargeAuthorization({
      email: profile.email,
      amount_usd: CANARY_AMOUNT_USD,
      reference,
      authorization_code: cfg.canary_authorization_code,
      metadata: { order_id: order.id, user_id: cfg.canary_user_id, gb_amount: String(CANARY_GB) },
    })
    // charge.success (webhook) does the crediting once Paystack's async event
    // lands. A decline is answered right here, synchronously, and Paystack sends
    // no event for it — so record it and alert now, instead of leaving a silent
    // 'pending' order for the cleanup to flip 24h later. If the webhook is what
    // is broken, reconcile credits the order within minutes and says so.
    if (result.status === 'failed') {
      await failPendingOrder(
        supabase,
        { id: order.id, user_id: cfg.canary_user_id, amount_usd: CANARY_AMOUNT_USD, gb_amount: CANARY_GB, is_canary: true, paystack_reference: reference },
        result.gateway_response ?? 'Declined',
        { source: 'canary' },
      )
    }
    return { initiated: true, reference, gateway_status: result.status }
  } catch (err: any) {
    // This is the one canary failure mode the webhook can never catch —
    // the charge_authorization call itself never reached Paystack (bad/
    // expired authorization_code, network error), so no charge.failed
    // event will ever fire for it. Alert directly here instead of relying
    // on the normal webhook path.
    await supabase.from('orders').update({
      payment_status: 'failed',
      failure_reason: `canary charge call failed: ${err.message}`,
      failed_at: new Date().toISOString(),
    }).eq('id', order.id)
    await sendEmail({
      to: process.env.ADMIN_EMAIL!,
      subject: `[CANARY PAYMENT FAILED] charge_authorization call errored`,
      html: `<p>The daily canary payment test couldn't even reach Paystack — this is
             separate from a normal card decline and usually means the saved
             authorization_code is stale/revoked, or Paystack's API is unreachable.</p>
             <p><strong>Error:</strong> ${escapeHtml(err.message)}</p>
             <p>Re-run a real checkout on the canary account to refresh the saved
             authorization_code, or check Paystack's status page.</p>`,
    }).catch((e) => console.error('[canary] alert email threw', e))
    return { initiated: false, error: err.message }
  }
}

// ── Network benchmark (public /status page) ────────────────────────
// Runs a small number of requests through a dedicated, admin-configured
// "house" proxy credential against neutral reachability targets (see
// lib/networkProbe.ts for exactly which, and why) and records the
// aggregated result. Skips cleanly — never throws — if unconfigured, not
// active, or not an 'http' protocol credential: SOCKS5 probing isn't
// implemented yet, and this task should never be the reason a cron run
// fails loudly. /api/admin/record-benchmark remains the manual fallback
// regardless of whether this is configured.
// ── Network benchmark (public /status page) ────────────────────────
// runConfiguredBenchmark (lib/networkProbe.ts) does all the real work —
// shared with the admin "test now" button on /admin/settings so both
// paths validate and probe identically. Never throws: skips cleanly if
// unconfigured, inactive, wrong protocol, or out of budget.
async function runBenchmark() {
  const supabase = await createAdminClient()
  return runConfiguredBenchmark(supabase)
}

// ── Pending-credential provisioning (public API + dashboard) ───────
// A credential created while Geonode was unreachable stays 'pending'. This
// retries them with backoff (claim_pending_credentials, migration 0042) —
// previously the ONLY thing that ever activated one was the owner's next
// purchase, so an API user who never bought again was stuck forever. Also
// re-applies live traffic-limit PATCHes that failed after a committed
// top-up. Small per-tick limits on purpose: Workers caps subrequests per
// invocation and this shares the */5 invocation with reconcile + usage.
// Never throws, so it can't block the chain.
async function runProvision() {
  try {
    const provision = await provisionPendingCredentials({ limit: 5 })
    const limits = await reconcileLimitSync(5)
    // Sessions pending for many hours get a one-time customer + admin notice
    // (they used to be retried silently, forever). Its own try/catch: a failed
    // notice must never fail the task — a non-OK provision task stops the
    // whole */5 chain after it.
    const stalled = await flagStalledPending(await createAdminClient()).catch((e) => {
      console.error('[cron provision] stalled-session flagging failed:', e)
      return { flagged: 0 }
    })
    return { provision, limits, stalled }
  } catch (e: any) {
    console.error('[cron provision] failed:', e)
    return { error: String(e?.message ?? e) }
  }
}

// ── Webhooks: delivery retries + threshold events ──────────────────
async function runWebhooks() {
  try {
    const retries = await runWebhookRetries()
    const thresholds = await runBandwidthThresholdWebhooks()
    return { retries, thresholds }
  } catch (e: any) {
    console.error('[cron webhooks] failed:', e)
    return { error: String(e?.message ?? e) }
  }
}

// ── Route handler ─────────────────────────────────────────────────
export async function POST(req: Request, context: { params: Promise<{ task: string }> }) {
  if (!validateCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { task } = await context.params
  const KNOWN = ['stock', 'usage', 'alerts', 'summary', 'cleanup', 'canary', 'reconcile', 'security', 'provision', 'webhooks', 'benchmark']
  if (!KNOWN.includes(task)) return NextResponse.json({ error: `Unknown task: ${task}` }, { status: 400 })

  // One copy of a task at a time (migration 0056). A skipped run reports ok
  // and is not recorded as a heartbeat: the run that holds the lease records
  // its own outcome when it finishes.
  const lock = await claimCronLock(task)
  if (lock === null) {
    console.warn(`[cron] task "${task}" skipped — a previous run is still in progress`)
    return NextResponse.json({ task, result: { skipped: 'already_running' }, timestamp: new Date().toISOString() })
  }
  try {
    let result
    switch (task) {
      case 'stock':     result = { ...(await runStockCheck()), cron_health: await checkCronFreshness() }; break
      case 'usage':     result = await runUsageSync();        break
      case 'alerts':    result = await runBandwidthAlerts();  break
      case 'summary':   result = await runDailySummary();     break
      case 'cleanup':   result = await runCleanup();          break
      case 'canary':    result = await runCanary();           break
      case 'reconcile': result = { reconcile: await runReconcile(), post_credit: await runPostCreditRetry() }; break
      case 'security':  result = await runSecurity();         break
      case 'provision': result = await runProvision();        break
      case 'webhooks':  result = await runWebhooks();         break
      case 'benchmark': result = await runBenchmark();        break
      default: return NextResponse.json({ error: `Unknown task: ${task}` }, { status: 400 })
    }
    // A task that catches its own failure reports `{ error }` inside a 200; the
    // heartbeat records that as a failed run too.
    await recordCronRun(task, findReportedError(result))
    return NextResponse.json({ task, result, timestamp: new Date().toISOString() })
  } catch (err: any) {
    console.error(`Cron task ${task} failed:`, err)
    await recordCronRun(task, String(err?.message ?? err))
    return NextResponse.json({ error: err.message }, { status: 500 })
  } finally {
    await releaseCronLock(task, lock)
  }
}

// Also supports GET so the same handler can be triggered manually (e.g. from
// a browser or curl) — gated by the CRON_SECRET header via validateCron(),
// same as POST. Not an admin-session check: hitting this requires knowing
// the secret and sending it as x-cron-secret, regardless of who's logged in.
export async function GET(req: Request, context: { params: Promise<{ task: string }> }) {
  return POST(req, context)
}
