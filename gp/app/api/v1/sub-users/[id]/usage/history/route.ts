import { getPeriodStats, MAX_STATS_GRANULARITY_UNITS } from '@/lib/upstream'
import { withApiAuth } from '@/lib/apiHelpers'
import { allowApiRequest } from '@/lib/rateLimit'
import { apiError } from '@/lib/apiAuth'
import { getOwnedCredential } from '@/lib/credentials'
import { NextResponse } from 'next/server'

const MAX_DAYS = 90

// GET /api/v1/sub-users/:id/usage/history?days=7&granularity=day|hour
// Per-period bandwidth and request counts for one sub-user, from the
// provider's statistics service. days: 1–90 (default 7). granularity "hour"
// is limited to 30 days (the provider caps a query at 720 periods).
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET sub-user usage history', async ({ user, supabase, key }) => {
    const { id } = await context.params
    const url = new URL(req.url)

    const rawDays = url.searchParams.get('days')
    const days = rawDays === null ? 7 : Number(rawDays)
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return apiError(400, 'invalid_request', `days must be a whole number between 1 and ${MAX_DAYS}.`)
    }
    const granularity = url.searchParams.get('granularity') ?? 'day'
    if (granularity !== 'day' && granularity !== 'hour') {
      return apiError(400, 'invalid_request', 'granularity must be "day" or "hour".')
    }
    if (granularity === 'hour' && days * 24 > MAX_STATS_GRANULARITY_UNITS) {
      return apiError(400, 'invalid_request', `granularity "hour" supports at most ${MAX_STATS_GRANULARITY_UNITS / 24} days.`)
    }

    const cred = await getOwnedCredential(supabase, user.id, id, 'id, status, upstream_username')
    if (!cred) return apiError(404, 'not_found', 'Sub-user not found')
    if (!cred.upstream_username) {
      return apiError(409, 'conflict', 'This sub-user has not been activated yet, so it has no usage history.')
    }

    // Charged only once the request is valid and owned: bad parameters and wrong ids
    // used to burn the budget. Each call fans out up to 30 requests on the one shared reseller API key
    // at the provider, so an unthrottled loop here could exhaust its limits
    // for every customer. 10/minute per key on top of the general limiter.
    if (!(await allowApiRequest('API_HISTORY_RATE_LIMITER', key.id))) {
      return apiError(429, 'rate_limited', 'Usage history is limited to 10 requests/minute per key. Retry after the Retry-After interval.', { 'Retry-After': '60', 'X-RateLimit-Limit': '10' })
    }


    const to = new Date()
    const from = new Date(to.getTime() - days * 24 * 3_600_000)
    let stats
    try {
      stats = await getPeriodStats(cred.upstream_username, from, to, granularity)
    } catch (e) {
      console.error('[v1 usage history] provider stats failed', id, e)
      return apiError(502, 'upstream_unavailable', 'Usage statistics are temporarily unavailable. Try again shortly.')
    }

    const GB = 1024 * 1024 * 1024
    const points = stats.map((p) => ({
      period_start: p.periodStart,
      gb: Math.round((p.bandwidthBytes / GB) * 1000) / 1000,
      successful_requests: p.successfulRequests,
      failed_requests: p.failedRequests,
      success_rate: p.successRate,
    }))
    return NextResponse.json({
      id: cred.id, from: from.toISOString(), to: to.toISOString(), granularity,
      total_gb: Math.round(points.reduce((s, p) => s + p.gb, 0) * 1000) / 1000,
      points,
    }, { headers: { 'X-RateLimit-Limit': '10' } }) // this route's own limit, not the general 120
  })
}
