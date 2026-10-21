import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
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
}

// Tasks report failures as `{ error: "…" }` somewhere in a 200 body. Returns the
// first one found in the first few levels, or null.
export function findReportedError(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 4) return null
  const v = value as Record<string, unknown>
  if (typeof v.error === 'string' && v.error) return v.error
  for (const k of Object.keys(v)) {
    const hit = findReportedError(v[k], depth + 1)
    if (hit) return hit
  }
  return null
}

export async function recordCronRun(task: string, error: string | null): Promise<void> {
  try {
    const admin = await createAdminClient()
    const { data: shouldAlert, error: rpcErr } = await admin.rpc('record_cron_task_run', {
      p_task: task, p_ok: error === null, p_error: error,
    })
    if (rpcErr) { console.error('[cronHealth] record failed', task, rpcErr.message); return }
    if (shouldAlert === true && process.env.ADMIN_EMAIL) {
      await sendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: `[CRON FAILING] "${task}" has failed 3 runs in a row`,
        html: `<p>The scheduled task <strong>${escapeHtml(task)}</strong> has reported an error on its last 3 runs.</p>
               <p><strong>Latest error:</strong> ${escapeHtml(error ?? 'unknown')}</p>
               <p>This alert repeats at most once a day while it keeps failing. Status of every task:
               <a href="${appUrl()}/admin/settings">Admin → Settings → Scheduled tasks</a>.</p>`,
      })
    }
  } catch (e) {
    console.error('[cronHealth] record threw', task, e)
  }
}

// Called from the hourly 'stock' task: emails once per incident about tasks that
// have stopped running altogether.
export async function checkCronFreshness(): Promise<{ stale: string[] } | { error: string }> {
  try {
    const admin = await createAdminClient()
    const { data, error } = await admin.rpc('claim_stale_cron_tasks', { p_max_age_seconds: CRON_MAX_AGE_SECONDS })
    if (error) { console.error('[cronHealth] stale check failed', error.message); return { error: error.message } }
    const rows = (data ?? []) as { task: string; last_run_at: string }[]
    if (rows.length && process.env.ADMIN_EMAIL) {
      await sendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: `[CRON STOPPED] ${rows.map((r) => r.task).join(', ')} not running`,
        html: `<p>These scheduled tasks have not run within their expected window:</p>
               <ul>${rows.map((r) => `<li><strong>${escapeHtml(r.task)}</strong> — last ran ${escapeHtml(r.last_run_at)}</li>`).join('')}</ul>
               <p>Check Cloudflare → Workers → Cron Triggers and the Worker logs.
               <a href="${appUrl()}/admin/settings">Admin → Settings → Scheduled tasks</a></p>`,
      })
    }
    return { stale: rows.map((r) => r.task) }
  } catch (e) {
    console.error('[cronHealth] freshness check threw', e)
    return { error: String((e as Error)?.message ?? e) }
  }
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
