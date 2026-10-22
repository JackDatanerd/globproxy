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
// (The old .github/workflows/cron-*.yml dispatchers this replaced have been
// deleted. If any of them ever reappears alongside this, every task would
// double-fire.)
//
// SCHEDULE: matched to the real, already-proven cadence in those three
// workflows (see CRON_TASKS below for the mapping and reasoning) rather
// than guessed — usage every 5 min, stock hourly, and alerts → summary →
// cleanup once a day at 8am UTC (originally chained like cron-daily.yml's
// `needs:`; now run independently — see INDEPENDENT_CHAINS below).
// If you want tighter alerting than once a day
// — e.g. a customer crossing 95% usage at 9am currently won't be emailed
// until the next day's 8am run — that's a deliberate product change to
// make separately, not something to fold in here silently.

// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from './.open-next/worker.js'
import { guardApiRequest, guardResponse, limitBody } from './lib/edgeGuard'

// Keep this in sync with wrangler.jsonc's triggers.crons array — every
// pattern here needs a matching entry there, and vice versa. Cloudflare
// cron expressions run in UTC. scripts/check-cron-sync.mjs enforces this (and
// that every task name exists in app/api/cron/[task]/route.ts); it runs at the
// start of `npm run build:cf`, so drift fails the deploy instead of silently
// skipping tasks.
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
//   - canary: once a day at 8:05am UTC — deliberately its own entry, 5
//     minutes after the alerts/summary/cleanup chain rather than folded
//     into it. runCanary makes a real ~$0.50 Paystack charge against a
//     saved authorization to exercise the full payment pipeline
//     end-to-end; chaining it after cleanup would mean an unrelated
//     cleanup failure silently skips the one check that exists
//     specifically to catch payment-pipeline outages — the opposite of
//     what canary is for. It stays a no-op (see runCanary's own
//     not_configured check) until canary_user_id and
//     canary_authorization_code are set in platform_settings.
//
// canary (migration 0036, app/api/cron/[task]/route.ts) is now scheduled
// below alongside benchmark — both were added after the original three-
// workflow replacement this file's header comment describes.
const CRON_TASKS: Record<string, string[]> = {
  // reconcile (payments safety net) and security (auth notices) never throw, so they can't block usage.
  // provision + webhooks (migration 0042) also never throw, and run LAST so
  // they can't hold up usage sync: provision retries pending credentials and
  // failed traffic-limit syncs; webhooks retries failed deliveries and fires
  // bandwidth-threshold events. Both keep per-tick work small because
  // Workers caps subrequests per invocation and the chain shares one.
  '*/5 * * * *': ['reconcile', 'security', 'usage', 'provision', 'webhooks', 'invites'],
  // resellers first: it never fails the chain, and invitation expiry / low-stock /
  // payout-day reminders are idempotent, so hourly is safe and doesn't depend on
  // the daily chain (a failing 'cleanup' must not swallow payout day).
  '0 * * * *': ['resellers', 'stock'],
  '0 8 * * *': ['alerts', 'summary', 'cleanup'],
  '0 */6 * * *': ['benchmark'],
  '5 8 * * *': ['canary'],
}

// ── Edge cache for anonymous page views ──────────────────────────────
// The app runs with OpenNext's "dummy" incremental cache (open-next.config.ts),
// so Next's own caching — including `export const revalidate` — does nothing
// here, and every view of a marketing page or the public /status page ran a
// full server render (the status page, a database query too) for every
// visitor. This serves repeat anonymous GETs of a fixed allow-list of pages
// from Cloudflare's per-colo cache for a few minutes instead.
//
// The cache key includes the deployed version id (wrangler.jsonc's
// version_metadata binding). Cloudflare's per-colo cache is NOT purged by a
// deploy, and a deploy replaces the hashed /_next/static files, so without the
// version in the key every cached page would point at JS that no longer exists
// for up to EDGE_CACHE_TTL_SECONDS after each release.
//
// What keeps it safe:
//  - only these exact public paths, only GET, only requests with NO cookie
//    and NO Authorization header (so anything personalised, or any signed-in
//    visitor, always reaches the real app);
//  - only requests with no query string (that excludes `?ref=` referral
//    landings and every Next `?_rsc=` client-navigation fetch) and none of
//    the RSC / server-action headers — otherwise a cached HTML page could be
//    handed to a client that asked for flight data;
//  - only 200 text/html responses that set no cookie are stored.
// Worst case after a deploy or a status change is ~EDGE_CACHE_TTL_SECONDS of
// staleness on those pages. The x-edge-cache header says HIT or MISS.
const EDGE_CACHE_TTL_SECONDS = 300
const EDGE_CACHEABLE_PATHS: RegExp[] = [
  /^\/$/,
  /^\/status$/,
  /^\/(privacy|terms|refunds)$/,
  /^\/docs\/api$/,
  /^\/blog(\/[^/]+)?$/,
  /^\/locations(\/[^/]+)?$/,
]

function isEdgeCacheable(request: Request, url: URL): boolean {
  if (request.method !== 'GET') return false
  if (url.search !== '') return false
  if (!EDGE_CACHEABLE_PATHS.some((re) => re.test(url.pathname))) return false
  const h = request.headers
  if (h.has('cookie') || h.has('authorization')) return false
  if (h.has('rsc') || h.has('next-action') || h.has('next-router-state-tree') || h.has('next-router-prefetch')) return false
  return true
}

function appOriginOf(env: any): string | undefined {
  try {
    return env?.NEXT_PUBLIC_APP_URL ? new URL(env.NEXT_PUBLIC_APP_URL).origin : undefined
  } catch {
    return undefined
  }
}

let warnedNoVersion = false

async function fetchWithEdgeCache(request: Request, env: any, ctx: any): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return handler.fetch(request, env, ctx)
  }

  // Request guard for /api/*: body-size cap and same-origin enforcement for
  // state-changing calls (see lib/edgeGuard.ts for what is exempt and why).
  const verdict = guardApiRequest(request, url, appOriginOf(env))
  if (verdict) return guardResponse(verdict)
  if (url.pathname.startsWith('/api/')) {
    const limited = await limitBody(request)
    if (!limited.ok) return guardResponse(limited.verdict)
    request = limited.request
  }

  if (!isEdgeCacheable(request, url)) return handler.fetch(request, env, ctx)

  // One synthetic key per path AND deployed version: the real request's
  // headers must not split (or poison) the cache, and a new deploy must start
  // from an empty cache.
  const version: string | undefined = env?.CF_VERSION_METADATA?.id
  if (!version && !warnedNoVersion) {
    warnedNoVersion = true
    console.error('[edge-cache] env.CF_VERSION_METADATA is missing (wrangler.jsonc version_metadata) — cached pages will outlive a deploy')
  }
  const key = new Request(`${url.origin}${url.pathname}?v=${encodeURIComponent(version ?? 'unknown')}`, { method: 'GET' })
  let cache: Cache | undefined
  try {
    cache = (caches as unknown as { default: Cache }).default
    const hit = await cache.match(key)
    if (hit) {
      const out = new Response(hit.body, hit)
      // The stored copy carries `public, max-age=…` only so Cloudflare's cache
      // will keep it. The BROWSER must not: the same URL renders differently
      // once the visitor signs in (e.g. the homepage call-to-action), so a
      // browser-cached anonymous copy would linger after login.
      out.headers.set('Cache-Control', 'private, no-cache, max-age=0, must-revalidate')
      out.headers.set('x-edge-cache', 'HIT')
      return out
    }
  } catch (e) {
    console.error('[edge-cache] lookup failed, serving uncached', e)
    cache = undefined
  }

  const res: Response = await handler.fetch(request, env, ctx)
  const storable =
    cache &&
    res.status === 200 &&
    !res.headers.has('set-cookie') &&
    (res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')

  if (storable && cache) {
    const forCache = new Response(res.clone().body, res)
    forCache.headers.set('Cache-Control', `public, max-age=${EDGE_CACHE_TTL_SECONDS}`)
    ctx.waitUntil(cache.put(key, forCache).catch((e: unknown) => console.error('[edge-cache] store failed', e)))
  }

  const out = new Response(res.body, res)
  out.headers.set('x-edge-cache', 'MISS')
  return out
}

export default {
  fetch: fetchWithEdgeCache,

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
    // Only the host matters (the request never leaves this Worker), but it
    // must parse: a stray trailing slash in the secret used to produce
    // "https://host//api/cron/…", which the router answers with a redirect —
    // not ok, so the whole chain stopped silently every tick.
    let base = 'https://globproxy.com'
    try {
      if (env.NEXT_PUBLIC_APP_URL) base = new URL(env.NEXT_PUBLIC_APP_URL).origin
    } catch {
      console.error('[scheduled] NEXT_PUBLIC_APP_URL is not a valid URL — falling back to', base)
    }

    // waitUntil so the scheduled invocation doesn't get torn down before
    // the chain (and everything each step awaits — email sends, Geonode
    // calls, Supabase writes) actually finishes.
    ctx.waitUntil(runTaskChain(base, env.CRON_SECRET ?? '', tasks, handler, env, ctx, INDEPENDENT_CHAINS.has(event.cron)))
  },
}

// Looks for an `error` string anywhere in the first few levels of a task's
// JSON result ({ task, result: { provision: { error } } } and the like).
// Returns it, or null. Never throws: a body that isn't JSON is just "no error".
async function taskReportedError(res: Response): Promise<string | null> {
  try {
    const body = await res.clone().json()
    const find = (v: any, depth: number): string | null => {
      if (!v || typeof v !== 'object' || depth > 4) return null
      if (typeof v.error === 'string' && v.error) return v.error
      for (const k of Object.keys(v)) {
        const hit = find(v[k], depth + 1)
        if (hit) return hit
      }
      return null
    }
    return find(body?.result, 0)
  } catch {
    return null
  }
}

// Cron patterns whose tasks are INDEPENDENT of each other. A failing task there
// is logged and the rest still run: webhook retries and bandwidth-threshold
// events have nothing to do with the usage sync, and must not go silent for as
// long as one of the tasks before them is failing (the chain used to stop at
// the first non-OK response).
//
// The daily 8am chain is in here too. It inherited cron-daily.yml's `needs:`
// ordering, but nothing in it actually depends on the step before: cleanup
// (abandoned orders, expired MFA sessions, CSP / usage / session pruning) reads
// nothing alerts or summary produce. As a dependent chain, one Resend timeout in
// the alerts loop, or a missing mail key making the summary throw, skipped the
// cleanup for that day. Every task still records its own heartbeat and failure.
const INDEPENDENT_CHAINS = new Set(['*/5 * * * *', '0 8 * * *'])

// Runs tasks in order. For a dependent chain it stops at the first failure
// rather than firing blind on top of a known-bad state; for the independent
// chains above it carries on. (No chain is dependent today; the mode is kept
// for a future one whose steps really do feed each other.)
async function runTaskChain(
  base: string,
  cronSecret: string,
  tasks: string[],
  handler: any,
  env: any,
  ctx: any,
  continueOnFailure = false
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
        if (!continueOnFailure) return // stop the chain, matching needs:
        continue
      }
      // Several tasks (reconcile, provision, webhooks, …) catch their own
      // failures so they can never block the chain, and report them as
      // `{ error }` inside a 200 response — which the status check above
      // reads as success. Surface those in the persisted log instead of
      // letting them vanish. The chain still continues: that is exactly why
      // those tasks swallow their errors.
      const reported = await taskReportedError(res)
      if (reported) console.error(`[scheduled] cron task "${task}" finished but reported an error:`, reported)
    } catch (e) {
      console.error(`[scheduled] cron task "${task}" threw:`, e)
      if (!continueOnFailure) return // stop the chain, matching needs:
    }
  }
}
