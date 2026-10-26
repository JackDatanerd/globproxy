import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createAdminClient } from '@/lib/supabase/server'
import { rateLimited, missingRateLimiters } from '@/lib/rateLimit'
import { CRON_MAX_AGE_SECONDS, STOCK_TASK_MAX_AGE_SECONDS } from '@/lib/cronHealth'

// Health / readiness probe. Used by the deploy workflow right after a deploy
// (it rolls the Worker back if this reports the new version as broken) and
// safe to point an uptime monitor at.
//
// Public, so it reveals nothing beyond ok/fail per check and the deployed
// version id. A caller that also sends the x-cron-secret header additionally
// gets the NAMES of any missing required settings — under neutral labels, since
// the deploy log of a public repository is itself public.
//
//   200  database reachable and every required setting present
//   503  something is missing or unreachable (body says which check failed)
export const dynamic = 'force-dynamic'

const DB_TIMEOUT_MS = 3000

// [label shown to callers, environment variable the app reads]
const REQUIRED_ENV: [string, string, string?][] = [
  ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'],
  ['SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  ['SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
  ['UPSTREAM_API_KEY', 'UPSTREAM_API_KEY', 'GEONODE_API_KEY'],
  ['UPSTREAM_RESELLER_ID', 'UPSTREAM_RESELLER_ID', 'GEONODE_RESELLER_ID'],
  ['PAYSTACK_SECRET_KEY', 'PAYSTACK_SECRET_KEY'],
  ['RESEND_API_KEY', 'RESEND_API_KEY'],
  ['CRON_SECRET', 'CRON_SECRET'],
  ['APP_URL', 'NEXT_PUBLIC_APP_URL'],
  ['ADMIN_EMAIL', 'ADMIN_EMAIL'],
  ['FROM_EMAIL', 'FROM_EMAIL'],
]

// Settings the app runs without, but should not. Reported (to a caller holding
// the cron secret) as warnings; they never turn the probe red. Neutral labels,
// because the deploy log of a public repository is itself public.
const RECOMMENDED_ENV: [string, string][] = [
  ['DATA_ENCRYPTION_KEY', 'MFA_ENCRYPTION_KEY'],
  ['BOT_CHECK_SECRET', 'TURNSTILE_SECRET_KEY'],
]

function deployedVersion(): string {
  try {
    const { env } = getCloudflareContext({ async: false }) as unknown as {
      env: { CF_VERSION_METADATA?: { id?: string } }
    }
    return env?.CF_VERSION_METADATA?.id ?? 'unknown'
  } catch {
    return 'dev' // not running under Workers
  }
}

function hasSecret(req: Request): boolean {
  const expected = process.env.CRON_SECRET ?? ''
  const given = req.headers.get('x-cron-secret') ?? ''
  if (!expected) return false
  // Compare BYTE lengths: timingSafeEqual throws when the buffers differ in length, and a
  // header with a multi-byte character can match the secret's character count but not its
  // byte count — a 500 only for the right length, i.e. a length oracle for the secret.
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Scheduled tasks that have not reported inside their window. Read-only (unlike
// checkCronFreshness it neither emails nor stamps an alert), so an external uptime monitor can
// poll it as often as it likes. 'usage' runs every 5 minutes: 20 minutes is four missed ticks.
const DEEP_MAX_AGES: Record<string, number> = { ...CRON_MAX_AGE_SECONDS, stock: STOCK_TASK_MAX_AGE_SECONDS, usage: 20 * 60 }

async function staleCronTasks(): Promise<string[] | null> {
  try {
    const admin = await createAdminClient()
    const { data, error } = await admin.from('cron_task_runs').select('task, last_run_at')
    if (error || !data) return null
    const seen = new Map(data.map((r) => [r.task as string, new Date(r.last_run_at as string).getTime()]))
    const now = Date.now()
    // A task with no row at all has never reported: that is stale too (a trigger that never fired).
    return Object.entries(DEEP_MAX_AGES)
      .filter(([task, maxS]) => { const at = seen.get(task); return at === undefined || !(now - at <= maxS * 1000) })
      .map(([task]) => task)
  } catch {
    return null
  }
}

async function databaseReachable(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const admin = await createAdminClient()
    const query = admin.from('platform_settings').select('key').limit(1).then((r) => r)
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), DB_TIMEOUT_MS)
    })
    const { error } = await Promise.race([query, timeout])
    return !error
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function GET(req: Request) {
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'health')
  if (limited) return limited

  const missing = REQUIRED_ENV.filter(([, name, alt]) => !process.env[name]?.trim() && !(alt && process.env[alt]?.trim())).map(([label]) => label)
  const database = await databaseReachable()
  // A missing rate-limit binding silently disables that limiter, so on a real
  // deploy it counts as broken. null = not on Workers (local dev): not checked.
  const noLimiters = missingRateLimiters()
  const limitersOk = noLimiters === null || noLimiters.length === 0
  const ok = database && missing.length === 0 && limitersOk

  const body: Record<string, unknown> = {
    status: ok ? 'ok' : 'degraded',
    version: deployedVersion(),
    checks: {
      database: database ? 'ok' : 'fail',
      config: missing.length === 0 ? 'ok' : 'fail',
      rate_limiters: limitersOk ? 'ok' : 'fail',
    },
  }
  let status = ok ? 200 : 503
  if (hasSecret(req)) {
    // ?deep=1 (secret holders only — the deploy smoke test does not send it, so a task that is
    // merely late right after a deploy can never trigger a rollback): also report the scheduler.
    // Point an external uptime monitor at /api/health?deep=1 with the x-cron-secret header.
    if (new URL(req.url).searchParams.get('deep') === '1') {
      const stale = await staleCronTasks()
      body.cron = stale === null ? 'unknown' : stale.length ? 'stale' : 'ok'
      if (stale?.length) body.stale_tasks = stale
      if (stale === null || stale.length) status = 503
    }
    if (missing.length) body.missing = missing
    if (noLimiters?.length) body.missing_limiters = noLimiters
    const warnings = RECOMMENDED_ENV.filter(([, name]) => !process.env[name]?.trim()).map(([label]) => label)
    if (warnings.length) body.warnings = warnings
  }

  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function HEAD(req: Request) {
  const res = await GET(req)
  return new Response(null, { status: res.status, headers: res.headers })
}
