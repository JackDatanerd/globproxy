// Cloudflare Workers entry point. The OpenNext Cloudflare adapter only
// generates a fetch handler (.open-next/worker.js) — this file wraps it
// to add a native scheduled() handler too, per OpenNext's documented
// pattern: https://opennext.js.org/cloudflare/howtos/custom-worker
//
// WHY THIS EXISTS: usage-sync, the stock/exposure check, user bandwidth
// alerts, the daily admin summary, and stale-order cleanup used to be
// triggered by an external service (cron-job.org) making an HTTP POST to
// /api/cron/[task] on a schedule. That's an extra network hop, an extra
// secret (CRON_SECRET) whose only job was proving the request actually
// came from them, and a real production incident already happened
// because of it: migration 0010's own history records cron-job.org
// auto-disabling the usage-sync job after 26 consecutive failures,
// silently, with nothing in-app noticing until gb_used had gone stale
// platform-wide.
//
// Cloudflare Cron Triggers remove the external dependency entirely —
// Cloudflare invokes this Worker's scheduled() handler directly, inside
// the same runtime, with no network round trip and nothing to leak or
// rotate.
//
// Deliberately NOT reimplementing runStockCheck/runUsageSync/etc. here.
// Instead this self-invokes the existing, already-tested
// /api/cron/[task] route via the generated fetch handler — the exact
// same code path that ran under cron-job.org, completely unchanged,
// including its process.env-based Supabase/Geonode client construction.
// Only WHO calls it changes, not what runs. CRON_SECRET stays as a
// defense-in-depth check even though nothing external can reach a
// scheduled() invocation — costs nothing, and means route.ts needed zero
// changes for this migration.
//
// ACTION NEEDED AFTER DEPLOYING THIS: delete/disable the cron-job.org
// jobs. Leaving both running would double-fire every task — harmless for
// idempotent ones (usage, cleanup), but 'stock' and 'summary' have no
// de-dupe guard the way the bandwidth-threshold alerts do, so you'd get
// duplicate admin emails until the old jobs are removed.
//
// VERIFY THE SCHEDULE: the five cron patterns below are reasonable
// defaults, not a copy of whatever was actually configured on
// cron-job.org (that config lives on their dashboard, not in this repo —
// there was no way to read it from here). Adjust CRON_TASKS and
// wrangler.jsonc's triggers.crons together if your real intervals
// differed, especially for 'usage' — usageSync.ts's own comments assume
// a ~5 minute cadence, so keep that one close to what's below unless you
// have a specific reason to change it.

// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from './.open-next/worker.js'

// Keep this in sync with wrangler.jsonc's triggers.crons array — every
// pattern here needs a matching entry there, and vice versa. Cloudflare
// cron expressions run in UTC.
const CRON_TASKS: Record<string, string> = {
  '*/5 * * * *': 'usage',    // usage-sync — see usageSync.ts's ~5 min cadence comments
  '*/10 * * * *': 'stock',   // stock/exposure check + usage-sync freshness watchdog
  '*/15 * * * *': 'alerts',  // user bandwidth threshold (80%/95%) alerts
  '0 9 * * *': 'summary',    // daily admin summary — 9am UTC
  '0 * * * *': 'cleanup',    // stale pending-order cleanup — hourly
}

export default {
  fetch: handler.fetch,

  async scheduled(event: any, env: any, ctx: any) {
    const task = CRON_TASKS[event.cron]
    if (!task) {
      console.error(`[scheduled] no task mapped for cron pattern "${event.cron}" — check wrangler.jsonc and custom-worker.ts are in sync`)
      return
    }

    // NEXT_PUBLIC_APP_URL and CRON_SECRET are both pushed as real Workers
    // secrets on every deploy (see .github/workflows/deploy.yml) — that's
    // what makes them available on `env` here, same as they're available
    // as process.env.* inside the Next.js request-handling code this
    // self-invokes.
    const base = env.NEXT_PUBLIC_APP_URL || 'https://globproxy.com'
    const req = new Request(`${base}/api/cron/${task}`, {
      method: 'POST',
      headers: { 'x-cron-secret': env.CRON_SECRET ?? '' },
    })

    // waitUntil so the scheduled invocation doesn't get torn down before
    // the self-fetch (and everything it awaits — email sends, Geonode
    // calls, Supabase writes) actually finishes.
    ctx.waitUntil(
      handler.fetch(req, env, ctx)
        .then(async (res: Response) => {
          if (!res.ok) {
            console.error(`[scheduled] cron task "${task}" returned ${res.status}:`, await res.text().catch(() => ''))
          }
        })
        .catch((e: unknown) => {
          console.error(`[scheduled] cron task "${task}" threw:`, e)
        })
    )
  },
}
