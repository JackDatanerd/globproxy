import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createAdminClient } from '@/lib/supabase/server'
import { rateLimited, missingRateLimiters } from '@/lib/rateLimit'

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
const REQUIRED_ENV: [string, string][] = [
  ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'],
  ['SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  ['SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
  ['UPSTREAM_API_KEY', 'GEONODE_API_KEY'],
  ['UPSTREAM_RESELLER_ID', 'GEONODE_RESELLER_ID'],
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
  if (!expected || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
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

  const missing = REQUIRED_ENV.filter(([, name]) => !process.env[name]?.trim()).map(([label]) => label)
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
  if (hasSecret(req)) {
    if (missing.length) body.missing = missing
    if (noLimiters?.length) body.missing_limiters = noLimiters
    const warnings = RECOMMENDED_ENV.filter(([, name]) => !process.env[name]?.trim()).map(([label]) => label)
    if (warnings.length) body.warnings = warnings
  }

  return NextResponse.json(body, { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}

export async function HEAD(req: Request) {
  const res = await GET(req)
  return new Response(null, { status: res.status, headers: res.headers })
}
