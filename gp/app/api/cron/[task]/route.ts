import { createAdminClient } from '@/lib/supabase/server'
import { syncAllUsage } from '@/lib/usageSync'
import { computeStockStatus } from '@/lib/stockStatus'
import { sendEmail, escapeHtml } from '@/lib/email'
import { dispatchWebhook } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

// Secured with CRON_SECRET env var
// Set this in Cloudflare Workers env vars and wrangler.jsonc
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
  const stock = await computeStockStatus(supabase)
  const syncHealth = await checkUsageSyncFreshness(supabase)

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

  if (exposureBreach || floorBreach) {
    const subject = exposureBreach
      ? `[EXPOSURE ALERT] Stock (${stock.available_gb.toFixed(1)}GB) can't cover what's sold (${stock.exposure_gb.toFixed(1)}GB unused-but-allocated)`
      : `[LOW STOCK] Geonode bandwidth: ${stock.available_gb.toFixed(1)}GB remaining`
    await sendEmail({
      to: process.env.ADMIN_EMAIL!,
      subject,
      html: `<p><strong>Available:</strong> ${stock.available_gb.toFixed(1)}GB of ${stock.total_gb.toFixed(1)}GB total</p>
             <p><strong>Allocated to customers:</strong> ${stock.total_allocated_gb.toFixed(1)}GB</p>
             <p><strong>Actually used so far:</strong> ${stock.total_used_gb.toFixed(1)}GB</p>
             <p><strong>Exposure (allocated but not yet used):</strong> ${stock.exposure_gb.toFixed(1)}GB</p>
             ${exposureBreach ? '<p style="color:#e24b4a"><strong>If customers drew down their full remaining allocation right now, you would run short.</strong></p>' : ''}
             <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/settings">Go to Admin Panel →</a></p>`,
    })
    return { action: 'alert_sent', ...stock, usage_sync: syncHealth }
  }
  return { action: 'ok', ...stock, usage_sync: syncHealth }
}

// ── Usage sync ───────────────────────────────────────────────────
// Implementation lives in lib/usageSync.ts — shared with the admin
// "sync now" button (app/api/admin/sync-usage) so there is exactly one
// place that decides how gb_used gets reconciled from Geonode, not two
// that can quietly diverge.
const runUsageSync = syncAllUsage

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
      .from('profiles').select('email, full_name').eq('id', acc.user_id).single()
    if (!profile?.email) continue

    const firstName = escapeHtml(profile.full_name?.split(' ')[0]) || 'there'
    const avail = acc.available_gb

    if (pct >= 95 && !acc.alerted_95_at) {
      await sendEmail({
        to: profile.email,
        subject: `🚨 Only ${avail.toFixed(1)}GB remaining — GlobProxy`,
        html: `<p>Hi ${firstName}, you've used ${pct.toFixed(0)}% of your bandwidth. Only ${avail.toFixed(1)}GB remains.</p>
               <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/buy">Top up now →</a>`,
      })
      // Same trigger, same data, as a webhook — fired from right here
      // rather than a separate scan so there's exactly one place deciding
      // "has this account crossed a threshold," not two that could drift.
      await dispatchWebhook(acc.user_id, 'bandwidth_threshold_crossed', {
        threshold_pct: 95, used_pct: pct, available_gb: avail, total_gb: acc.total_gb,
      }).catch((e) => console.error('[webhooks] bandwidth_threshold_crossed dispatch threw', acc.user_id, e))
      await supabase.from('bandwidth_accounts')
        .update({ alerted_95_at: new Date().toISOString() })
        .eq('user_id', acc.user_id)
      sent++
    } else if (pct >= 80 && pct < 95 && !acc.alerted_80_at) {
      await sendEmail({
        to: profile.email,
        subject: `Heads up: ${avail.toFixed(1)}GB bandwidth remaining`,
        html: `<p>Hi ${firstName}, you've used ${pct.toFixed(0)}% of your bandwidth. ${avail.toFixed(1)}GB remains.</p>
               <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/buy">Buy more →</a>`,
      })
      await dispatchWebhook(acc.user_id, 'bandwidth_threshold_crossed', {
        threshold_pct: 80, used_pct: pct, available_gb: avail, total_gb: acc.total_gb,
      }).catch((e) => console.error('[webhooks] bandwidth_threshold_crossed dispatch threw', acc.user_id, e))
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
    .select('amount_usd, gb_amount')
    .eq('payment_status', 'paid')
    .gte('paid_at', `${yesterday}T00:00:00Z`)
    .lt('paid_at', `${today}T00:00:00Z`)

  const rev = orders?.reduce((s, o) => s + o.amount_usd, 0) ?? 0
  const gb = orders?.reduce((s, o) => s + o.gb_amount, 0) ?? 0

  const { count: newUsers } = await supabase.from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', `${yesterday}T00:00:00Z`)

  await sendEmail({
    to: process.env.ADMIN_EMAIL!,
    subject: `GlobProxy Daily Summary — ${yesterday}`,
    html: `<div style="font-family:sans-serif">
      <h2 style="color:#0057ff">Daily Summary — ${yesterday}</h2>
      <p><strong>Revenue:</strong> $${rev.toFixed(2)}</p>
      <p><strong>GB sold:</strong> ${gb.toFixed(1)} GB</p>
      <p><strong>Orders:</strong> ${orders?.length ?? 0}</p>
      <p><strong>New users:</strong> ${newUsers ?? 0}</p>
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin">Open admin panel →</a>
    </div>`,
  })
  return { revenue: rev, gb_sold: gb, new_users: newUsers }
}

// ── Cleanup stale orders ──────────────────────────────────────────
async function runCleanup() {
  const supabase = await createAdminClient()
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: stale } = await supabase.from('orders')
    .select('id').eq('payment_status', 'pending').lt('created_at', cutoff)

  for (const o of stale ?? []) {
    await supabase.from('orders').update({ payment_status: 'failed' }).eq('id', o.id)
  }

  // Expired MFA "verified this browser" tokens (migration 0020). Already
  // functionally inert everywhere they're checked (every lookup filters
  // expires_at > now()) — this just keeps the table from growing
  // unbounded on a long-lived deployment, same reasoning as the stale
  // orders above.
  const { error: mfaErr } = await supabase.rpc('cleanup_expired_mfa_sessions')
  if (mfaErr) console.error('cleanup_expired_mfa_sessions failed:', mfaErr)

  return { cleaned: stale?.length ?? 0, mfa_sessions_swept: !mfaErr }
}

// ── Network benchmark (public /status page) ────────────────────────
// This does NOT make live requests through the proxy pool yet — doing
// that correctly from a Cloudflare Worker (raw TCP via `cloudflare:sockets`,
// manual HTTP-proxy CONNECT tunneling, picking targets that don't look
// like scripted abuse of a third-party site's anti-bot system) is a real
// sub-project of its own, and shipping unverified networking code
// straight into an unattended production cron job is exactly the kind
// of thing worth getting right in a follow-up rather than guessing at
// here. Until that's built, this task is a documented no-op: it exists
// so the cron wiring (auth, task dispatch, error handling) is already in
// place, and turning it on later is a matter of filling in the body
// below, not re-plumbing the route. In the meantime, /api/admin/record-
// benchmark is the real way to populate the /status page.
async function runBenchmark() {
  const supabase = await createAdminClient()
  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'benchmark_credential_id')
    .single()

  if (!setting?.value) {
    return { action: 'skipped', reason: 'benchmark_credential_id not configured — use /api/admin/record-benchmark to publish measurements manually for now' }
  }

  // TODO: once a tested proxy-tunneling implementation exists, use the
  // credential at setting.value to run a small number of requests
  // against a short list of neutral, ToS-safe reachability targets (not
  // commercial anti-bot targets on an unattended schedule) and insert
  // the aggregated result into network_benchmarks here.
  return { action: 'skipped', reason: 'live benchmark probe not yet implemented' }
}

// ── Route handler ─────────────────────────────────────────────────
export async function POST(req: Request, context: { params: Promise<{ task: string }> }) {
  if (!validateCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { task } = await context.params
  try {
    let result
    switch (task) {
      case 'stock':     result = await runStockCheck();       break
      case 'usage':     result = await runUsageSync();        break
      case 'alerts':    result = await runBandwidthAlerts();  break
      case 'summary':   result = await runDailySummary();     break
      case 'cleanup':   result = await runCleanup();          break
      case 'benchmark': result = await runBenchmark();        break
      default: return NextResponse.json({ error: `Unknown task: ${task}` }, { status: 400 })
    }
    return NextResponse.json({ task, result, timestamp: new Date().toISOString() })
  } catch (err: any) {
    console.error(`Cron task ${task} failed:`, err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// Also supports GET so the same handler can be triggered manually (e.g. from
// a browser or curl) — gated by the CRON_SECRET header via validateCron(),
// same as POST. Not an admin-session check: hitting this requires knowing
// the secret and sending it as x-cron-secret, regardless of who's logged in.
export async function GET(req: Request, context: { params: Promise<{ task: string }> }) {
  return POST(req, context)
}
