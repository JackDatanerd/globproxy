import { createAdminClient } from '@/lib/supabase/server'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'

// Heartbeat for scheduled tasks (migration 0052). Every run of /api/cron/[task]
// records whether it worked; three failures in a row, or a task that simply
// stops running, emails the admin once per incident. Before this, only the
// 'usage' task was watched: a task that failed quietly (reconcile, provision,
// webhooks, security — each swallows its own errors and reports them inside a
// 200 body) left nothing but a log line.
//
// Everything here must never throw — it runs on the cron path and a monitoring
// problem must not become a cron outage.

// How long a task may go without running before it counts as stopped. Roughly
// three missed ticks. 'usage' is excluded (its own 20-minute watchdog lives in
// the stock task) and so is 'stock' (it is the thing doing the checking).
export const CRON_MAX_AGE_SECONDS: Record<string, number> = {
  reconcile: 30 * 60,
  security: 30 * 60,
  provision: 30 * 60,
  webhooks: 30 * 60,
  benchmark: 18 * 60 * 60,
  alerts: 36 * 60 * 60,
  summary: 36 * 60 * 60,
  cleanup: 36 * 60 * 60,
  canary: 36 * 60 * 60,
  invites: 30 * 60,
  recharge: 30 * 60,
  resellers: 3 * 60 * 60,
  // Hourly: executes due account deletions (after the cool-off), sends the reminder and
  // retries deletions that finished with leftovers.
  deletions: 3 * 60 * 60,
}

export { findReportedError } from '@/lib/cronReport'

export async function recordCronRun(task: string, error: string | null): Promise<void> {
  try {
    const admin = await createAdminClient()
    const { data: shouldAlert, error: rpcErr } = await admin.rpc('record_cron_task_run', {
      p_task: task, p_ok: error === null, p_error: error,
    })
    if (rpcErr) { console.error('[cronHealth] record failed', task, rpcErr.message); return }
    if (shouldAlert === true && process.env.ADMIN_EMAIL) {
      const delivered = await sendEmailSafe({
        to: process.env.ADMIN_EMAIL,
        subject: `[CRON FAILING] "${task}" has failed 3 runs in a row`,
        html: `<p>The scheduled task <strong>${escapeHtml(task)}</strong> has reported an error on its last 3 runs.</p>
               <p><strong>Latest error:</strong> ${escapeHtml(error ?? 'unknown')}</p>
               <p>This alert repeats at most once a day while it keeps failing. Status of every task:
               <a href="${appUrl()}/admin/settings">Admin → Settings → Scheduled tasks</a>.</p>`,
      })
      // The database already stamped alerted_at when it said "alert now". If the
      // mail provider did not accept the message, un-stamp it so the next failing
      // run tries again instead of staying silent for 24 hours.
      if (!delivered) {
        await admin.from('cron_task_runs').update({ alerted_at: null }).eq('task', task)
          .then(({ error: e }) => { if (e) console.error('[cronHealth] could not re-arm failing-task alert', task, e.message) })
      }
    }
  } catch (e) {
    console.error('[cronHealth] record threw', task, e)
  }
}

// Emails once per incident about tasks that have stopped running altogether.
// Called from the hourly 'stock' task (every task except stock/usage) and, for
// 'stock' itself, from the */5 'security' task (checkStockWatchdog) — nothing may
// be the only thing watching itself.
async function reportStale(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  maxAges: Record<string, number>,
  label: string,
): Promise<{ stale: string[] } | { error: string }> {
  const { data, error } = await admin.rpc('claim_stale_cron_tasks', { p_max_age_seconds: maxAges })
  if (error) { console.error(`[cronHealth] ${label} stale check failed`, error.message); return { error: error.message } }
  const rows = (data ?? []) as { task: string; last_run_at: string }[]
  if (rows.length && process.env.ADMIN_EMAIL) {
    const delivered = await sendEmailSafe({
      to: process.env.ADMIN_EMAIL,
      subject: `[CRON STOPPED] ${rows.map((r) => r.task).join(', ')} not running`,
      html: `<p>These scheduled tasks have not run within their expected window:</p>
             <ul>${rows.map((r) => `<li><strong>${escapeHtml(r.task)}</strong> — last ran ${escapeHtml(r.last_run_at)}</li>`).join('')}</ul>
             <p>Check Cloudflare → Workers → Cron Triggers and the Worker logs.
             <a href="${appUrl()}/admin/settings">Admin → Settings → Scheduled tasks</a></p>`,
    })
    // claim_stale_cron_tasks stamped stale_alerted_at before this send; put it back
    // if the provider refused, so the next check reports the same tasks again.
    if (!delivered) {
      await admin.from('cron_task_runs').update({ stale_alerted_at: null }).in('task', rows.map((r) => r.task))
        .then(({ error: e }) => { if (e) console.error('[cronHealth] could not re-arm stale alert', e.message) })
    }
  }
  return { stale: rows.map((r) => r.task) }
}

export async function checkCronFreshness(): Promise<{ stale: string[] } | { error: string }> {
  try {
    return await reportStale(await createAdminClient(), CRON_MAX_AGE_SECONDS, 'freshness')
  } catch (e) {
    console.error('[cronHealth] freshness check threw', e)
    return { error: String((e as Error)?.message ?? e) }
  }
}

// 'stock' is excluded from CRON_MAX_AGE_SECONDS because it runs the check above —
// so if it dies (a failing chain, a bad deploy) nothing noticed. Called from the
// */5 'security' task, which is in turn watched by 'stock': each watches the other.
export const STOCK_TASK_MAX_AGE_SECONDS = 3 * 60 * 60
export async function checkStockWatchdog(): Promise<{ stale: string[] } | { error: string }> {
  try {
    return await reportStale(await createAdminClient(), { stock: STOCK_TASK_MAX_AGE_SECONDS }, 'stock-watchdog')
  } catch (e) {
    console.error('[cronHealth] stock watchdog threw', e)
    return { error: String((e as Error)?.message ?? e) }
  }
}

// ── Usage-sync freshness ────────────────────────────────────────────────
// Used to live in the cron route and ran only from 'stock'. It now also runs from
// the */5 'security' task, so a dead hourly chain cannot silence it. De-duplicated
// by platform_settings.usage_sync_stale_alerted_at, so calling it from both is safe.
// A NULL timestamp (never synced — a fresh deploy) is "unknown", not stale.
export const USAGE_SYNC_STALE_THRESHOLD_MS = 20 * 60 * 1000 // ~4x the 5-minute cadence

export async function checkUsageSyncFreshness(
  supabase: Awaited<ReturnType<typeof createAdminClient>>
): Promise<{ stale: boolean; reason?: string; already_alerted?: boolean; alert_failed?: boolean }> {
  const { data: rows } = await supabase
    .from('platform_settings')
    .select('key, value')
    .in('key', ['usage_last_synced_at', 'usage_sync_stale_alerted_at'])
  const settings = Object.fromEntries((rows ?? []).map(r => [r.key, r.value]))

  if (!settings.usage_last_synced_at) return { stale: false, reason: 'never_synced' }

  const ageMs = Date.now() - new Date(settings.usage_last_synced_at).getTime()
  if (!Number.isFinite(ageMs)) return { stale: false, reason: 'unreadable_timestamp' }
  const stale = ageMs > USAGE_SYNC_STALE_THRESHOLD_MS

  if (!stale) {
    // Recovered — clear any prior alert flag so a future staleness re-alerts.
    if (settings.usage_sync_stale_alerted_at) {
      await supabase.from('platform_settings').delete().eq('key', 'usage_sync_stale_alerted_at')
    }
    return { stale: false }
  }

  if (settings.usage_sync_stale_alerted_at) return { stale: true, already_alerted: true }

  // Only mark the incident as reported once the provider ACCEPTED the message —
  // otherwise a provider hiccup at that moment silenced this alert until the next
  // successful sync cleared the flag.
  const delivered = process.env.ADMIN_EMAIL ? await sendEmailSafe({
    to: process.env.ADMIN_EMAIL,
    subject: `[USAGE SYNC STALE] Last successful sync was ${Math.round(ageMs / 60000)} min ago`,
    html: `<p>Usage-sync (the 'usage' cron task) hasn't completed successfully in over
           ${Math.round(USAGE_SYNC_STALE_THRESHOLD_MS / 60000)} minutes.</p>
           <p><strong>Last known good sync:</strong> ${escapeHtml(settings.usage_last_synced_at)}</p>
           <p>gb_used and account balances are going stale until this recovers — check
           whether the cron trigger for the 'usage' task is still firing and whether the proxy provider is reachable.</p>`,
  }) : false
  if (!delivered) return { stale: true, already_alerted: false, alert_failed: true }
  await supabase.from('platform_settings')
    .upsert({ key: 'usage_sync_stale_alerted_at', value: new Date().toISOString() }, { onConflict: 'key' })
  return { stale: true, already_alerted: false }
}

// ── Run lock ────────────────────────────────────────────────────────────
// A task takes a lease before it runs (migration 0056). The */5 chain can
// outlast its own tick; without this the next tick started the same task a
// second time on top of the first. The lease expires by itself, so a Worker
// that dies mid-run cannot block the task for longer than CRON_LOCK_LEASE_SECONDS.
export const CRON_LOCK_LEASE_SECONDS = 10 * 60

// Returns a release token, 'unlocked' when locking itself is unavailable (the
// task then runs as it always did — a lock problem must never become a cron
// outage), or null when another run holds the lease.
export async function claimCronLock(task: string): Promise<string | null> {
  try {
    const admin = await createAdminClient()
    const token = crypto.randomUUID()
    const { data, error } = await admin.rpc('claim_cron_task_lock', {
      p_task: task, p_lease_seconds: CRON_LOCK_LEASE_SECONDS, p_token: token,
    })
    if (error) { console.error('[cronHealth] lock claim failed — running unlocked', task, error.message); return 'unlocked' }
    return typeof data === 'string' && data === token ? token : null
  } catch (e) {
    console.error('[cronHealth] lock claim threw — running unlocked', task, e)
    return 'unlocked'
  }
}

export async function releaseCronLock(task: string, token: string): Promise<void> {
  if (token === 'unlocked') return
  try {
    const admin = await createAdminClient()
    const { error } = await admin.rpc('release_cron_task_lock', { p_task: task, p_token: token })
    if (error) console.error('[cronHealth] lock release failed', task, error.message)
  } catch (e) {
    console.error('[cronHealth] lock release threw', task, e)
  }
}
