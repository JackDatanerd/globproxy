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
// ACTION NEEDED AFTER THIS DEPLOYS AND IS VERIFIED WORKING: delete
// .github/workflows/cron-usage.yml, cron-stock.yml, and cron-daily.yml —
// they are the real dispatcher this replaces (cron-job.org, separately,
// has already been disabled). Leaving them running alongside this would
// double-fire every task. Do NOT delete them before confirming the
// Cloudflare triggers actually fired successfully at least once each —
// check the Triggers tab / wrangler tail, don't just trust the deploy
// succeeding.
//
// SCHEDULE: matched to the real, already-proven cadence in those three
// workflows (see CRON_TASKS below for the mapping and reasoning) rather
// than guessed — usage every 5 min, stock hourly, and alerts → summary →
// cleanup once a day at 8am UTC as a chain, exactly replicating
// cron-daily.yml's `needs:` dependency (each step only runs if the
// previous one succeeded). If you want tighter alerting than once a day
// — e.g. a customer crossing 95% usage at 9am currently won't be emailed
// until the next day's 8am run — that's a deliberate product change to
// make separately, not something to fold in here silently.

// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from './.open-next/worker.js'

// Keep this in sync with wrangler.jsonc's triggers.crons array — every
// pattern here needs a matching entry there, and vice versa. Cloudflare
// cron expressions run in UTC.
//
// These three schedules replace the three GitHub Actions workflows
// (cron-usage.yml, cron-stock.yml, cron-daily.yml) — matched to their
// real, already-proven cadence rather than guessed at:
//   - usage: every 5 min (cron-usage.yml)
//   - stock: hourly (cron-stock.yml)
//   - alerts → summary → cleanup: once a day at 8am UTC, run in that
//     order, each step only running if the previous one succeeded
//     (cron-daily.yml used GitHub Actions' `needs:` for this exact
//     chain — replicated below rather than dropped).
//   - benchmark: every 6 hours. New, not replacing anything — this is
//     the network-probe task that backs /status, previously only
//     runnable by hand via the "Run test now" button in
//     /admin/settings. Picked 6h as a starting cadence since each run
//     is a handful of tiny requests (see lib/networkProbe.ts) against a
//     small dedicated credential's GB allowance; tighten or loosen once
//     there's a sense of how fast that budget actually depletes.
//
// canary (migration 0036, app/api/cron/[task]/route.ts) is NOT included
// here yet — it exists as a task but was never wired to any scheduler,
// cron-job.org included, so this isn't a regression, just something
// still worth deciding on separately.
const CRON_TASKS: Record<string, string[]> = {
  '*/5 * * * *': ['usage'],
  '0 * * * *': ['stock'],
  '0 8 * * *': ['alerts', 'summary', 'cleanup'],
  '0 */6 * * *': ['benchmark'],
}

export default {
  fetch: handler.fetch,

  async scheduled(event: any, env: any, ctx: any) {
    const tasks = CRON_TASKS[event.cron]
    if (!tasks) {
      console.error(`[scheduled] no tasks mapped for cron pattern "${event.cron}" — check wrangler.jsonc and custom-worker.ts are in sync`)
      return
    }

    // NEXT_PUBLIC_APP_URL and CRON_SECRET are both pushed as real Workers
    // secrets on every deploy (see .github/workflows/deploy.yml) — that's
    // what makes them available on `env` here, same as they're available
    // as process.env.* inside the Next.js request-handling code this
    // self-invokes.
    const base = env.NEXT_PUBLIC_APP_URL || 'https://globproxy.com'

    // waitUntil so the scheduled invocation doesn't get torn down before
    // the chain (and everything each step awaits — email sends, Geonode
    // calls, Supabase writes) actually finishes.
    ctx.waitUntil(runTaskChain(base, env.CRON_SECRET ?? '', tasks, handler, env, ctx))
  },
}

// Runs tasks in order, stopping at the first failure — same semantics as
// cron-daily.yml's `needs:` chain (alerts → summary → cleanup): a failed
// step means the ones after it don't run this cycle, rather than firing
// blind on top of a known-bad state.
async function runTaskChain(
  base: string,
  cronSecret: string,
  tasks: string[],
  handler: any,
  env: any,
  ctx: any
) {
  for (const task of tasks) {
    const req = new Request(`${base}/api/cron/${task}`, {
      method: 'POST',
      headers: { 'x-cron-secret': cronSecret },
    })
    try {
      const res: Response = await handler.fetch(req, env, ctx)
      if (!res.ok) {
        console.error(`[scheduled] cron task "${task}" returned ${res.status}:`, await res.text().catch(() => ''))
        return // stop the chain, matching needs:
      }
    } catch (e) {
      console.error(`[scheduled] cron task "${task}" threw:`, e)
      return // stop the chain, matching needs:
    }
  }
}
