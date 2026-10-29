import { backfillWhitelistMirrors, retryPendingWhitelistReplays } from '@/lib/whitelistMirror'
import { appUrl } from '@/lib/appUrl'
import { createAdminClient } from '@/lib/supabase/server'
import { syncAllUsage } from '@/lib/usageSync'
import { computeStockStatus } from '@/lib/stockStatus'
import { sendEmail, sendEmailSafe, escapeHtml } from '@/lib/email'
import { runWebhookRetries, runBandwidthThresholdWebhooks, runIntegrationHousekeeping } from '@/lib/webhooks'
import { warnExpiringApiKeys } from '@/lib/apiKeyExpiry'
import { provisionPendingCredentials, reconcileLimitSync, flagStalledPending, alertStuckLimitSync } from '@/lib/credentials'
import { runConfiguredBenchmark } from '@/lib/networkProbe'
import { chargeAuthorization, generateReference, verifyTransaction, paymentMismatchReason } from '@/lib/paystack'
import { activateBandwidth, retryPostCredit } from '@/lib/bandwidth'
import { alertAdminPayment, alertMismatchOnce } from '@/lib/paymentAlerts'
import { failPendingOrder } from '@/lib/orderFailure'
import { flushSecurityNoticesDetailed } from '@/lib/securityEvents'
import { REFERRAL_GB_BONUS } from '@/lib/referrals'
import { fetchAllRows } from '@/lib/dbPaging'
import { findReportedError, recordCronRun, checkCronFreshness, checkStockWatchdog, checkUsageSyncFreshness, claimCronLock, releaseCronLock } from '@/lib/cronHealth'
import { runInviteNotices, runResellerMaintenance } from '@/lib/resellerCron'
import { runBroadcasts } from '@/lib/broadcast'
import { runAccountDeletions } from '@/lib/accountDeletionCron'
import { listVerifiedOperatorsDue } from '@/lib/adminVo'
import { runAutoRecharge, captureSavedCardIfRequested } from '@/lib/autoRecharge'
import { ATTEMPT_OPEN_MS } from '@/lib/rechargeRules'
import { summaryDaysDue, nextDay } from '@/lib/summaryDays'
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

// Usage-sync freshness watchdog: lib/cronHealth.ts (checkUsageSyncFreshness). It runs from
// the hourly 'stock' task AND the */5 'security' task, so one dead chain cannot silence it.

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
      // Stamp the 24h reminder window only when the provider accepted the mail.
      const delivered = process.env.ADMIN_EMAIL ? await sendEmailSafe({
          to: process.env.ADMIN_EMAIL,
          subject: '[UPSTREAM API FAILING] Could not read proxy provider stock',
          html: `<p>The hourly stock check could not read the proxy provider's account balance, so stock and
                 exposure are unknown. Usage sync and provisioning depend on the same API — check the provider
                 status page and that the reseller API key is still valid.</p>
                 <p style="color:#666">Error (also in the worker logs): <code>${escapeHtml(String((e as any)?.message ?? e).slice(0, 300))}</code></p>`,
        }) : false
      if (delivered) {
        await supabase.from('platform_settings')
          .upsert({ key: 'upstream_api_alert_at', value: new Date().toISOString() }, { onConflict: 'key' })
      }
    }
    // `error` makes the cron heartbeat (lib/cronHealth) record this run as failed, so it
    // also shows on the admin cron-health panel — not only in the alert email.
    return { action: 'stock_unavailable', error: 'upstream_stock_unavailable', usage_sync: syncHealth }
  }
  // Recovered — clear the failure flag so the next outage alerts immediately.
  await supabase.from('platform_settings').delete().eq('key', 'upstream_api_alert_at')

  await supabase.from('platform_settings')
    .upsert({ key: 'upstream_stock', value: JSON.stringify(stock) }, { onConflict: 'key' })

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
  // still not consumed anywhere — there's no automatic upstream purchase
  // pipeline in this codebase yet, so "auto-reload" today only means "alert
  // me earlier," not "buy more automatically." That's a separate feature.
  const { data: settingsRows } = await supabase
    .from('platform_settings')
    .select('key, value')
    .in('key', ['auto_reload_enabled', 'auto_reload_threshold_gb'])
  const settings = Object.fromEntries((settingsRows ?? []).map(r => [r.key, r.value]))
  const autoReloadEnabled = settings.auto_reload_enabled === 'true'
  // A non-numeric value (typed into the admin box, or a bad env var) used to make the
  // threshold NaN, and `available_gb <= NaN` is always false — the low-stock alert
  // silently switched itself off. Fall back to the next valid source instead.
  const finite = (v: unknown) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? n : null }
  const threshold = (autoReloadEnabled ? finite(settings.auto_reload_threshold_gb) : null)
    ?? finite(process.env.STOCK_ALERT_THRESHOLD) ?? 10
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
    ? `[EXPOSURE ALERT] Stock (${stock.available_gb.toFixed(1)}GB) can't cover unallocated + pending + paused customer GB (${stock.exposure_gb.toFixed(1)}GB)`
    : `[LOW STOCK] Proxy bandwidth stock: ${stock.available_gb.toFixed(1)}GB remaining`
  const delivered = process.env.ADMIN_EMAIL ? await sendEmailSafe({
    to: process.env.ADMIN_EMAIL,
    subject,
    html: `<p><strong>Available to allocate:</strong> ${stock.available_gb.toFixed(1)}GB of ${stock.total_gb.toFixed(1)}GB total</p>
           <p><strong>Customer balances not yet allocated to a session:</strong> ${stock.unallocated_balances_gb.toFixed(1)}GB</p>
           <p><strong>Sessions waiting to be provisioned:</strong> ${stock.pending_allocated_gb.toFixed(1)}GB</p>
           <p><strong>Unused GB in customer-paused sessions (re-taken on resume):</strong> ${stock.paused_resume_gb.toFixed(1)}GB</p>
           <p><strong>Exposure (the three above):</strong> ${stock.exposure_gb.toFixed(1)}GB</p>
           <p style="color:#666">Already inside live sessions: ${stock.committed_unused_gb.toFixed(1)}GB unused of ${stock.total_allocated_gb.toFixed(1)}GB allocated — already deducted from upstream's available figure, so not counted as exposure.</p>
           ${exposureBreach ? '<p style="color:#e24b4a"><strong>If customers turned all their unallocated balance into sessions right now, you would run short.</strong></p>' : ''}
           <p><a href="${appUrl()}/admin/settings">Go to Admin Panel →</a></p>`,
  }) : false
  // Only a delivered alert starts the 24h suppression window; otherwise the next
  // hourly run tries again. `error` also puts the failed delivery on the heartbeat.
  if (!delivered) return { action: 'alert_not_delivered', error: 'stock alert email was not delivered', ...stock, usage_sync: syncHealth }
  await supabase.from('platform_settings')
    .upsert({ key: 'stock_alert_state', value: JSON.stringify({ kind: breachKind, at: new Date().toISOString() }) }, { onConflict: 'key' })
  return { action: 'alert_sent', ...stock, usage_sync: syncHealth }
}

// ── Usage sync ───────────────────────────────────────────────────
// Implementation lives in lib/usageSync.ts — shared with the admin
// "sync now" button (app/api/admin/sync-usage) so there is exactly one
// place that decides how gb_used gets reconciled from upstream, not two
// that can quietly diverge.
// syncAllUsage() THROWS when upstream's sub-user listing is incomplete (so an
// outage can't masquerade as a healthy sync). In the */5 chain a non-OK task
// stops every task after it (custom-worker.ts), and 'provision' + 'webhooks'
// run after 'usage' — webhook delivery retries and threshold events have
// nothing to do with upstream and must keep running during its outage. So the
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
// An alert counts as sent only when the mail provider ACCEPTED it. sendEmail()
// logs and returns a non-OK response instead of throwing, and the loop below
// used to flag the account as alerted regardless — so a provider 429/5xx on the
// day's run meant that customer was never warned again until their usage fell
// back under 80%. Throwing here leaves the flag unset (retried next run).
async function sendAlertEmail(p: { to: string; subject: string; html: string }) {
  const res = await sendEmail(p)
  if (!res.ok) throw new Error(`mail provider answered ${res.status}`)
}

async function runBandwidthAlerts() {
  const supabase = await createAdminClient()
  // Paged: a plain select is silently capped at 1000 rows, which would leave every
  // account past the 1000th without alerts.
  const { rows: accounts, error: accountsErr } = await fetchAllRows((from, to) =>
    supabase
      .from('bandwidth_accounts')
      .select('user_id, total_gb, used_gb, available_gb, alerted_80_at, alerted_95_at')
      .gt('total_gb', 0)
      .order('user_id', { ascending: true })
      .range(from, to)
  )
  if (accountsErr) console.error('[alerts] could not read every bandwidth account:', accountsErr)

  let sent = 0
  let failed = 0
  // One account's failure (a mail timeout, a bad row) must not stop the rest.
  for (const acc of accounts) {
   try {
    if (!acc.total_gb) continue
    // This measures how much of the purchased bandwidth is ALLOCATED (reserved into sessions
    // or handed to clients), not how much has been consumed — the e-mails say so. Was (used_gb / total_gb) — but the email below reports available_gb,
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

    // Is anything actually due? Almost every account on a run is already alerted (or
    // under 80%), so decide that from the row we already hold BEFORE paying for a
    // profile read — it used to read a profile for each of them, every day.
    const due95 = pct >= 95 && !acc.alerted_95_at
    const due80 = pct >= 80 && pct < 95 && !acc.alerted_80_at
    if (!due95 && !due80) continue

    // low_bandwidth_emails is the customer's opt-out for these advisory warnings
    // (Settings → "E-mail me when a session is running low"); only this once-a-day
    // account-level alert ignored it, so opting out still produced the e-mails.
    // If the column isn't migrated yet the first select errors — fall back to the
    // columns that have always existed (same approach as usageSync's firstName()).
    let { data: profile, error: profErr } = await supabase
      .from('profiles').select('email, full_name, referral_code, affiliate_status, low_bandwidth_emails').eq('id', acc.user_id).maybeSingle()
    if (profErr) {
      ;({ data: profile, error: profErr } = await supabase
        .from('profiles').select('email, full_name, referral_code, affiliate_status').eq('id', acc.user_id).maybeSingle() as any)
    }
    if (profErr) throw profErr
    // Deleted accounts keep their balance row with the email scrubbed to '[deleted]'.
    if (!profile?.email || profile.email.startsWith('[')) continue
    if ((profile as any).low_bandwidth_emails === false) continue

    const firstName = escapeHtml(profile.full_name?.split(' ')[0]) || 'there'
    const avail = acc.available_gb
    const referralLine = profile.referral_code
      ? `<p style="margin-top:16px;font-size:13px;color:#666;">${profile.affiliate_status === 'approved'
           ? 'Tip: share your affiliate link and earn commission on every order —'
           : `Tip: refer a friend and you both get ${REFERRAL_GB_BONUS}GB free —`}
           <a href="${appUrl()}/r/${profile.referral_code}">your link</a>.</p>`
      : ''

    if (due95) {
      await sendAlertEmail({
        to: profile.email,
        subject: `Only ${avail.toFixed(1)}GB left to allocate — GlobProxy`,
        html: `<p>Hi ${firstName}, ${pct.toFixed(0)}% of the bandwidth you bought is now set aside for your proxy sessions (and any clients you allocated to). Only ${avail.toFixed(1)}GB is left to allocate to a new session or top-up.</p>
               <p style="color:#666;font-size:13px;">Allocated bandwidth is reserved for those sessions — it is not used up until traffic actually flows through them.</p>
               <a href="${appUrl()}/dashboard/buy">Buy more bandwidth →</a>
               ${referralLine}`,
      })
      // (The bandwidth_threshold_crossed WEBHOOK no longer fires from this
      // once-a-day email run — it has its own 5-minute task, see
      // runBandwidthThresholdWebhooks in lib/webhooks.ts.)
      // Stamp the 80% flag too: an account that jumped straight past 80% must not get a
      // second, lower "Heads up" e-mail when it later settles back between 80% and 95%.
      const stamp = new Date().toISOString()
      await supabase.from('bandwidth_accounts')
        .update({ alerted_95_at: stamp, alerted_80_at: acc.alerted_80_at ?? stamp })
        .eq('user_id', acc.user_id)
      sent++
    } else if (due80) {
      await sendAlertEmail({
        to: profile.email,
        subject: `Heads up: ${avail.toFixed(1)}GB left to allocate`,
        html: `<p>Hi ${firstName}, ${pct.toFixed(0)}% of the bandwidth you bought is now set aside for your proxy sessions (and any clients you allocated to). ${avail.toFixed(1)}GB is left to allocate to a new session or top-up.</p>
               <p style="color:#666;font-size:13px;">Allocated bandwidth is reserved for those sessions — it is not used up until traffic actually flows through them.</p>
               <a href="${appUrl()}/dashboard/buy">Buy more →</a>
               ${referralLine}`,
      })
      await supabase.from('bandwidth_accounts')
        .update({ alerted_80_at: new Date().toISOString() })
        .eq('user_id', acc.user_id)
      sent++
    }
   } catch (e) {
    failed++
    console.error('[alerts] could not alert user', acc.user_id, e)
   }
  }
  // `error` makes the cron heartbeat record the run as failed (lib/cronHealth).
  return {
    alerts_sent: sent,
    ...(failed > 0 || accountsErr ? { alerts_failed: failed, error: accountsErr ? `bandwidth account read incomplete: ${accountsErr}` : `${failed} bandwidth alert(s) could not be sent` } : {}),
  }
}

// ── Daily summary ─────────────────────────────────────────────────
// Figures come from admin_order_stats — the same net-of-refunds basis the admin
// Overview and Cycles pages use, computed in the database. The task used to pull
// every order row (PostgREST caps that at 1000, so a busy day silently
// under-reported), ignored whether the e-mail was accepted, and e-mailed again on
// every re-run of the same day.
async function runDailySummary() {
  const supabase = await createAdminClient()
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
  const MARKER = 'daily_summary_sent_for'

  const adminTo = process.env.ADMIN_EMAIL
  if (!adminTo) return { error: 'ADMIN_EMAIL is not set — the daily summary has nowhere to go' }

  // The marker is the LAST day that was sent. A day whose e-mail was refused is sent by the
  // next run (up to SUMMARY_MAX_CATCHUP_DAYS back), oldest first, instead of being lost.
  const { data: marker } = await supabase.from('platform_settings').select('value').eq('key', MARKER).maybeSingle()
  const days = summaryDaysDue(marker?.value, yesterday)
  if (days.length === 0) return { skipped: true, reason: 'already_sent', day: yesterday }

  // Verified Operator reviews that are overdue. Nothing else tells the admin: it was a tile on a
  // page nobody is obliged to open. A failed read just leaves the line out of the e-mail.
  const voDue = await listVerifiedOperatorsDue(supabase)
  const voLine = !voDue.error && voDue.ids.length > 0
    ? `<p style="color:#b45309"><strong>Verified Operator reviews overdue:</strong> ${voDue.ids.length} — <a href="${appUrl()}/admin/affiliates?due=1">review them →</a></p>`
    : ''

  const sentDays: string[] = []
  let last: { revenue: number; gb_sold: number; orders: number; new_users: number | null } | null = null
  for (const day of days) {
    const next = nextDay(day)
    // Figures come from admin_order_stats — the same net-of-refunds basis the admin
    // Overview and Cycles pages use, computed in the database.
    const { data: statRows, error: statErr } = await supabase.rpc('admin_order_stats', {
      p_start: `${day}T00:00:00Z`, p_end: `${next}T00:00:00Z`,
    })
    if (statErr) return { error: `daily summary could not read order stats: ${statErr.message}`, sent_days: sentDays }
    const st = (statRows?.[0] ?? null) as { revenue_usd: number; gb_sold: number; order_count: number } | null
    const rev = Number(st?.revenue_usd ?? 0)
    const gb = Number(st?.gb_sold ?? 0)
    const orderCount = Number(st?.order_count ?? 0)

    const { count: newUsers, error: usersErr } = await supabase.from('profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', `${day}T00:00:00Z`)
      .lt('created_at', `${next}T00:00:00Z`) // that day only, like the revenue figures above
    if (usersErr) return { error: `daily summary could not count new users: ${usersErr.message}`, sent_days: sentDays }

    const delivered = await sendEmailSafe({
      to: adminTo,
      subject: `GlobProxy Daily Summary — ${day}`,
      html: `<div style="font-family:sans-serif">
      <h2 style="color:#0057ff">Daily Summary — ${day}</h2>
      <p><strong>Revenue (net of refunds):</strong> $${rev.toFixed(2)}</p>
      <p><strong>GB sold:</strong> ${gb.toFixed(1)} GB</p>
      <p><strong>Orders:</strong> ${orderCount}</p>
      <p><strong>New users:</strong> ${newUsers ?? 0}</p>
      ${day === yesterday ? voLine : ''}
      <a href="${appUrl()}/admin">Open admin panel →</a>
    </div>`,
    })
    // Stop at the first refusal: the marker stays on the last day that really went out, so the
    // next run starts from the failed day.
    if (!delivered) return { error: `daily summary e-mail for ${day} was not accepted by the mail provider`, sent_days: sentDays, revenue: rev }
    await supabase.from('platform_settings').upsert({ key: MARKER, value: day, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    sentDays.push(day)
    last = { revenue: rev, gb_sold: gb, orders: orderCount, new_users: newUsers }
  }
  return { sent_days: sentDays, ...(last ?? {}) }
}

// ── Reconcile uncredited orders against Paystack ──────────────────
// Safety net for the webhook: if a charge.success never arrived or its
// processing failed, any order that isn't credited yet (pending, or locally
// cancelled/failed) is re-verified directly with Paystack and credited if the
// money really arrived. First look is ~5 min after creation, then at most
// hourly for 3 days, then daily up to 14 days — bounded so abandoned checkouts don't cost Paystack
// calls forever. Never throws: it runs ahead of 'usage' in the same cron
// chain and a failure here must not block that.
async function runReconcile() {
  try {
    const supabase = await createAdminClient()
    const now = Date.now()
    const minAge = new Date(now - 5 * 60 * 1000).toISOString()
    const maxAge = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString()
    const recheck = new Date(now - 60 * 60 * 1000).toISOString()

    const COLS = 'id, user_id, payment_status, amount_usd, gb_amount, paystack_reference, is_canary, pay_currency, pay_amount, created_at, auto_recharge'
    const { data: fresh, error } = await supabase.from('orders')
      .select(COLS)
      .eq('bandwidth_credited', false)
      .in('payment_status', ['pending', 'cancelled', 'failed'])
      .not('paystack_reference', 'is', null)
      .lt('created_at', minAge)
      .gt('created_at', maxAge)
      .or(`reconcile_checked_at.is.null,reconcile_checked_at.lt.${recheck}`)
      .order('reconcile_checked_at', { ascending: true, nullsFirst: true })
      .limit(10)
    if (error) return { error: error.message }

    // Past the 3-day window the safety net used to stop, so a payment whose
    // webhook retries were also exhausted (Paystack gives up after ~3 days) was
    // never credited. Orders up to 14 days old keep getting a once-a-day look —
    // a handful per run, so it costs a few Paystack calls, not a flood.
    const agedMax = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString()
    const agedRecheck = new Date(now - 24 * 60 * 60 * 1000).toISOString()
    const { data: aged, error: agedErr } = await supabase.from('orders')
      .select(COLS)
      .eq('bandwidth_credited', false)
      .in('payment_status', ['pending', 'cancelled', 'failed'])
      .not('paystack_reference', 'is', null)
      .lte('created_at', maxAge)
      .gt('created_at', agedMax)
      .or(`reconcile_checked_at.is.null,reconcile_checked_at.lt.${agedRecheck}`)
      .order('reconcile_checked_at', { ascending: true, nullsFirst: true })
      .limit(5)
    if (agedErr) console.error('[reconcile] aged-order query failed', agedErr)
    const candidates = [...(fresh ?? []), ...(aged ?? [])]

    let recovered = 0, mismatched = 0, errors = 0, failed = 0
    for (const o of candidates ?? []) {
      let settled = true // whether to push the next look out by an hour
      let backoff = false // a persistent error: retry soon, but behind everything not yet looked at
      try {
        const txn = await verifyTransaction(o.paystack_reference!)
        if (txn.status === 'success') {
          const mismatch = paymentMismatchReason(txn, o)
          if (mismatch) {
            mismatched++
            await alertMismatchOnce(supabase, o.id, 'Reconcile: paid transaction does not match its order — NOT credited', {
              order_id: o.id, reference: o.paystack_reference, problem: mismatch,
            })
          } else {
            const result = await activateBandwidth({
              order_id: o.id, user_id: o.user_id, gb_amount: Number(o.gb_amount),
              paystack_reference: o.paystack_reference!, amount_usd: Number(o.amount_usd),
              is_canary: !!o.is_canary,
            })
            if (result.status === 'credited' || result.status === 'already_credited') await captureSavedCardIfRequested(supabase, o, txn.metadata, txn)
            if (result.status === 'credited') {
              recovered++
              await alertAdminPayment('Reconcile recovered an uncredited payment', {
                order_id: o.id, reference: o.paystack_reference, previous_status: o.payment_status,
                amount_usd: o.amount_usd, gb: o.gb_amount,
              })
            } else if (result.status === 'error') {
              errors++
              settled = false // retry on the next run
              backoff = true
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
        if (!/not found/i.test(String(e?.message))) { errors++; settled = false; backoff = true }
        else if (o.auto_recharge && o.payment_status === 'pending' && Date.now() - Date.parse(o.created_at) > ATTEMPT_OPEN_MS) {
          // An auto-recharge charge request that never reached Paystack (it timed out before
          // registering): nothing was charged and nobody is waiting on this order, but a
          // pending order counts against the customer's 30-day cap until cleanup. Close it now,
          // quietly — no e-mail, because no payment was ever attempted from the customer's side.
          await supabase.from('orders').update({
            payment_status: 'failed', failure_reason: 'The automatic charge never went through.', failed_at: new Date().toISOString(),
          }).eq('id', o.id).eq('payment_status', 'pending').eq('bandwidth_credited', false)
        }
      }
      if (settled) {
        await supabase.from('orders').update({ reconcile_checked_at: new Date().toISOString() }).eq('id', o.id)
      } else if (backoff) {
        // An order that errors every time (a bad row, a refused credit) used to keep
        // reconcile_checked_at NULL/old and so stayed at the FRONT of the queue
        // forever: ten of them would have starved every other uncredited order for
        // days. Stamp it so it is looked at again in ~10 minutes but sorts behind
        // orders that have not had a look yet.
        const isAged = Date.parse(o.created_at) <= now - 3 * 24 * 60 * 60 * 1000
        const window = isAged ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000
        await supabase.from('orders')
          .update({ reconcile_checked_at: new Date(Date.now() - (window - 10 * 60 * 1000)).toISOString() }).eq('id', o.id)
      }
    }
    return { checked: candidates.length, aged_checked: aged?.length ?? 0, recovered, mismatched, errors, failed }
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
  // One conditional UPDATE instead of select-then-update-each: the old loop made a
  // round trip per abandoned order (a few thousand would exhaust the Worker's
  // subrequest budget and throw away the MFA / CSP / session purges below), and its
  // errors were never looked at. The filter keeps the original guarantee — an order
  // paid in the meantime (webhook / verify-payment) is never overwritten with 'failed'.
  const { data: abandoned, error: abandonErr } = await supabase.from('orders').update({
    payment_status: 'failed',
    failure_reason: 'Abandoned — not paid within 24h',
    failed_at: new Date().toISOString(),
  }).eq('payment_status', 'pending').eq('bandwidth_credited', false).eq('auto_recharge', false).lt('created_at', cutoff).select('id')
  if (abandonErr) console.error('[cleanup] abandoned-order sweep failed:', abandonErr)
  // An automatic top-up is charged off-session, so the customer never "abandoned" it —
  // one still unresolved after 24h is a charge whose outcome was never confirmed. Say that
  // (the Billing page shows this reason), rather than blaming the customer.
  const { data: abandonedAuto, error: abandonAutoErr } = await supabase.from('orders').update({
    payment_status: 'failed',
    failure_reason: 'Automatic top-up was not confirmed within 24h',
    failed_at: new Date().toISOString(),
  }).eq('payment_status', 'pending').eq('bandwidth_credited', false).eq('auto_recharge', true).lt('created_at', cutoff).select('id')
  if (abandonAutoErr) console.error('[cleanup] auto top-up sweep failed:', abandonAutoErr)

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

  // Webhook-delivery / idempotency / API-request-log pruning and the API-key expiry
  // warnings moved to the independent 5-minute 'webhooks' task
  // (runIntegrationHousekeeping): this chain stops at its first failure.

  // Terminated ("hidden") sticky sessions are kept for a week, then purged:
  // nothing ever removed them, so they only accumulated (and count toward the
  // per-credential stored-session cap in migration 0059).
  const sessionCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { error: sessErr } = await supabase.from('proxy_sessions')
    .delete().not('terminated_at', 'is', null).lt('terminated_at', sessionCutoff)
  if (sessErr) console.error('terminated proxy_sessions purge failed:', sessErr)

  // Daily account usage (usage_daily, migration 0062) older than ~13 months: the
  // usage page only ever asks for 7/30/90 days.
  const usageCutoff = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { error: usageErr } = await supabase.from('usage_daily').delete().lt('day', usageCutoff)
  if (usageErr) console.error('usage_daily prune failed:', usageErr)

  // Any failed step is reported as `error`, which is what the cron heartbeat records
  // (lib/cronHealth.findReportedError) — they used to be logged and flagged as booleans
  // nothing ever read, so a table that stopped being pruned never showed as failing.
  const failedSteps = [
    abandonErr && 'abandoned orders', abandonAutoErr && 'auto top-up orders', mfaErr && 'MFA sessions', cspErr && 'CSP reports', sessErr && 'proxy sessions', usageErr && 'daily usage',
  ].filter(Boolean) as string[]
  return {
    cleaned: (abandoned?.length ?? 0) + (abandonedAuto?.length ?? 0), mfa_sessions_swept: !mfaErr, csp_pruned: !cspErr, sessions_purged: !sessErr, usage_daily_pruned: !usageErr,
    ...(failedSteps.length ? { error: `cleanup step(s) failed: ${failedSteps.join(', ')}` } : {}),
  }
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
  // Failures are collected and returned as `error` (the heartbeat only sees errors it
  // is handed) instead of being swallowed: the sweep that tells customers their
  // password or login e-mail changed could fail for days with the task showing green.
  const problems: string[] = []
  try {
    const flush = await flushSecurityNoticesDetailed(undefined, 2 * 60 * 1000)
    noticesSent = flush.sent
    if (flush.error) problems.push(flush.error)
  } catch (e) {
    console.error('[cron security] notice flush failed', e)
    problems.push(`notice flush threw: ${String((e as any)?.message ?? e)}`)
  }
  try {
    const supabase = await createAdminClient()
    const { data, error } = await supabase.rpc('cleanup_old_security_events')
    if (error) { console.error('[cron security] cleanup_old_security_events failed', error); problems.push(`audit-log retention failed: ${error.message}`) }
    else purged = typeof data === 'number' ? data : null
  } catch (e) {
    console.error('[cron security] cleanup threw', e)
    problems.push(`audit-log retention threw: ${String((e as any)?.message ?? e)}`)
  }
  // Cross-watchdogs: the hourly 'stock' task watches every other task, so something
  // other than 'stock' must notice when 'stock' (or the usage sync it also checks) goes
  // quiet. Both de-duplicate per incident and never throw.
  const stockWatchdog = await checkStockWatchdog()
  let usageFreshness: unknown = null
  try { usageFreshness = await checkUsageSyncFreshness(await createAdminClient()) }
  catch (e) { console.error('[cron security] usage freshness check failed', e); usageFreshness = { error: 'freshness_check_failed' } }
  return {
    notices_sent: noticesSent, events_purged: purged, stock_watchdog: stockWatchdog, usage_freshness: usageFreshness,
    ...(problems.length ? { error: problems.join('; ') } : {}),
  }
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

  // Configured but unreadable is a broken monitor, not a skip: report it as an error so the heartbeat
  // (and the 3-failures alert) shows it instead of the canary quietly never running.
  const { data: profile, error: profileErr } = await supabase
    .from('profiles').select('email').eq('id', cfg.canary_user_id).maybeSingle()
  if (profileErr) return { error: `canary could not read its test account: ${profileErr.message}` }
  if (!profile?.email || String(profile.email).startsWith('[')) return { error: 'canary_user_id is set but that account does not exist (or was deleted) — the daily payment test is NOT running' }

  // Once a day means once a day: a re-fired trigger or a manual GET used to charge the
  // test card again. 20h (not 24h) so tomorrow's scheduled run is never blocked by
  // today's having started a little late.
  const { count: recentCanaries, error: recentErr } = await supabase.from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('is_canary', true).gte('created_at', new Date(Date.now() - 20 * 3600_000).toISOString())
  if (recentErr) return { error: `canary could not check for a recent run: ${recentErr.message}` }
  if ((recentCanaries ?? 0) > 0) return { skipped: true, reason: 'already_ran_today' }

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
    const canaryMailed = await sendEmailSafe({
      to: process.env.ADMIN_EMAIL ?? '',
      subject: `[CANARY PAYMENT FAILED] charge_authorization call errored`,
      html: `<p>The daily canary payment test couldn't even reach Paystack — this is
             separate from a normal card decline and usually means the saved
             authorization_code is stale/revoked, or Paystack's API is unreachable.</p>
             <p><strong>Error:</strong> ${escapeHtml(err.message)}</p>
             <p>Re-run a real checkout on the canary account to refresh the saved
             authorization_code, or check Paystack's status page.</p>`,
    })
    return { initiated: false, error: canaryMailed ? err.message : `${err.message} (and the alert e-mail was NOT delivered)` }
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
// A credential created while upstream was unreachable stays 'pending'. This
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
    // A committed allocation the live proxy still hasn't accepted after 30 min: tell
    // the owner and the admin once (same never-throws rule as the notice above).
    const stuck = await alertStuckLimitSync(await createAdminClient()).catch((e) => {
      console.error('[cron provision] stuck-limit alert failed:', e)
      return { alerted: 0 }
    })
    // Mirror whitelists not yet copied locally (migration 0079) — bounded, never throws.
    const whitelist = await backfillWhitelistMirrors(await createAdminClient()).catch((e) => {
      console.error('[cron provision] whitelist mirror backfill failed:', e)
      return { checked: 0, mirrored: 0 }
    })
    // Whitelists that could not be put back on a re-provisioned session (0094) — bounded, never throws.
    const whitelistReplay = await retryPendingWhitelistReplays(await createAdminClient()).catch((e) => {
      console.error('[cron provision] whitelist replay retry failed:', e)
      return { checked: 0, restored: 0 }
    })
    return { provision, limits, stalled, stuck, whitelist, whitelistReplay }
  } catch (e: any) {
    console.error('[cron provision] failed:', e)
    return { error: String(e?.message ?? e) }
  }
}

// ── Webhooks: delivery retries + threshold events ──────────────────
async function runWebhooks() {
  try {
    // Thresholds FIRST: they store their events as due-now (defer), so the retry pass
    // right after sends them in this same tick instead of the next one. Each step is
    // isolated — one throwing used to skip the rest of the tick (no retries, no
    // pruning, no key-expiry warnings) until it stopped throwing.
    const step = async <T,>(label: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
      try { return await fn() } catch (e: any) { console.error(`[cron webhooks] ${label} failed:`, e); return { error: String(e?.message ?? e) } }
    }
    const thresholds = await step('thresholds', runBandwidthThresholdWebhooks)
    const retries = await step('retries', runWebhookRetries)
    const housekeeping = await step('housekeeping', () => runIntegrationHousekeeping(warnExpiringApiKeys))
    return { retries, thresholds, housekeeping }
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
  // Every task scheduled in custom-worker.ts's CRON_TASKS must be listed here, or it
  // answers 400 on every tick and silently never runs ('invites' and 'resellers' were
  // scheduled and handled in the switch below but missing from this list).
  // scripts/check-cron-sync.mjs fails the build when the two drift.
  const KNOWN = ['stock', 'usage', 'alerts', 'summary', 'cleanup', 'canary', 'reconcile', 'security', 'provision', 'webhooks', 'benchmark', 'invites', 'resellers', 'deletions', 'recharge', 'broadcasts']
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
      case 'stock': {
        // The stopped-task watchdog runs FIRST, on its own (it never throws): a failure anywhere
        // in the stock read or its alerting must not stop it reporting other tasks that went quiet.
        const cron_health = await checkCronFreshness()
        result = { ...(await runStockCheck()), cron_health }
        break
      }
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
      case 'invites':   result = await runInviteNotices();    break
      case 'resellers': result = await runResellerMaintenance(); break
      case 'deletions': result = await runAccountDeletions(); break
      case 'recharge':  result = await runAutoRecharge();     break
      case 'broadcasts': result = await runBroadcasts();      break
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
