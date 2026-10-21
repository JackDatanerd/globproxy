import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { getPeriodStats, getHostCountryStatsWithMeta, GeonodeApiError, type PeriodStat, type HostCountryStat } from '@/lib/geonode'
import { toCsv, csvResponse } from '@/lib/csv'
import { NextResponse } from 'next/server'

// Only three ranges (7/30/90 days) are exposed in the UI — keeping the allowed set closed
// (rather than accepting any integer) means every call this route ever
// makes stays comfortably under Geonode's 720-unit-at-granularity=day cap
// and under Cloudflare Workers' per-invocation subrequest budget (see the
// credential cap below).
const ALLOWED_RANGE_DAYS = [7, 30, 90] as const
type RangeDays = (typeof ALLOWED_RANGE_DAYS)[number]

function parseRange(value: string | null): RangeDays {
  const n = Number(value)
  return (ALLOWED_RANGE_DAYS as readonly number[]).includes(n) ? (n as RangeDays) : 7
}

// Subrequest budget (Cloudflare Workers' free-plan cap is 50 per invocation).
// Per credential: 1 period call + up to 2 host-country pages (500 rows each,
// HOST_COUNTRY_HARD_CAP below). The old cap of 15 credentials only counted 2
// calls each and ignored host-country pagination, so the real worst case,
// 15 x (1 + 4) = 75, blew the budget. 10 x (1 + 2) = 30, plus the two
// Supabase reads, stays under 50. Sorted by gb_used desc, so the heaviest
// consumers are always covered even if long-tail credentials are left out.
const MAX_CREDENTIALS = 10
const HOST_COUNTRY_HARD_CAP = 1000 // rows per credential = 2 pages of 500

type CredRow = {
  id: string
  label: string | null
  upstream_username: string | null
  country: string | null
  gb_used: number | null
}

// `credentialId` narrows the report to ONE session (the per-session drill-down
// in the usage page); without it the report covers the account's heaviest
// sessions. Read with the service role and an explicit user_id filter: the
// upstream_username column is not selectable with a customer session
// (migration 0059).
async function loadScopedCredentials(admin: Awaited<ReturnType<typeof createAdminClient>>, userId: string, credentialId?: string) {
  let q = admin
    .from('proxy_credentials')
    .select('id, label, upstream_username, country, gb_used')
    .eq('user_id', userId)
    .not('upstream_username', 'is', null)
  if (credentialId) q = q.eq('id', credentialId)
  const { data } = await q
    .order('gb_used', { ascending: false })
    .limit(MAX_CREDENTIALS)

  let countQ = admin
    .from('proxy_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .not('upstream_username', 'is', null)
  if (credentialId) countQ = countQ.eq('id', credentialId)
  const { count: totalCount } = await countQ

  const creds = (data ?? []) as CredRow[]
  return { creds, truncated: (totalCount ?? creds.length) > creds.length }
}

// NOTE: only credentials that still exist are included. A deleted
// credential's history is not shown (its consumed GB is archived into the
// account's used_gb total, but no per-day breakdown is kept), so the chart
// total can be lower than used_gb after deletions.

// Merges each credential's own per-period time series into a single
// account-level series keyed by day. There's no ".all scoped to just this
// user" option on Geonode's per-period endpoint — subUserFilter is either
// one username or every sub-user on the whole reseller account — so this
// is the only way to get an account-scoped (not reseller-wide) daily
// total across a user's multiple credentials.
function mergeSeries(perCredential: PeriodStat[][], dateFrom: Date, dateTo: Date): { date: string; gb: number }[] {
  const byDate = new Map<string, number>()
  // Zero-fill every UTC day in the requested range. Geonode only returns days
  // that had traffic, so the chart used to draw a straight line across the
  // gaps with evenly spaced points — a 3-day burst looked like a steady trend
  // and the x-axis dates skipped silently.
  for (let t = Date.UTC(dateFrom.getUTCFullYear(), dateFrom.getUTCMonth(), dateFrom.getUTCDate()),
           end = Date.UTC(dateTo.getUTCFullYear(), dateTo.getUTCMonth(), dateTo.getUTCDate());
       t <= end; t += 86_400_000) {
    byDate.set(new Date(t).toISOString().slice(0, 10), 0)
  }
  for (const series of perCredential) {
    for (const point of series) {
      const date = point.periodStart.slice(0, 10) // YYYY-MM-DD
      const bytes = byDate.get(date) ?? 0
      byDate.set(date, bytes + point.bandwidthBytes)
    }
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bytes]) => ({ date, gb: Math.round((bytes / 1024 / 1024 / 1024) * 10000) / 10000 }))
}

interface BreakdownRow {
  label: string
  host: string
  country: string
  gb: number
  requests: number
  successRate: number
}

function buildBreakdown(rows: { label: string; stats: HostCountryStat[] }[]): BreakdownRow[] {
  const out: BreakdownRow[] = []
  for (const { label, stats } of rows) {
    for (const s of stats) {
      out.push({
        label,
        host: s.host,
        country: s.country?.toUpperCase() || '—',
        gb: Math.round((s.bandwidthBytes / 1024 / 1024 / 1024) * 1000) / 1000,
        requests: s.totalRequests,
        successRate: s.successRate,
      })
    }
  }
  return out.sort((a, b) => b.gb - a.gb)
}

function geonodeStatsErrorResponse(e: unknown): NextResponse {
  if (e instanceof GeonodeApiError) {
    if (e.status === 401 || e.status === 403) {
      console.error('Geonode rejected reseller API key on stats call:', e.status, e.body)
      return NextResponse.json(
        { error: 'Usage history is temporarily unavailable. Please try again shortly.' },
        { status: 502 }
      )
    }
    console.error('Unexpected Geonode stats error:', e.status, e.body)
    return NextResponse.json({ error: 'Usage history is temporarily unavailable.' }, { status: 502 })
  }
  console.error('Unexpected usage-history error:', e)
  return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  // Each call fans out up to 30 Geonode requests on the one shared reseller
  // API key, so an unthrottled loop here could exhaust Geonode's limits for
  // every customer. 10/min per user+IP is far above what the UI needs.
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', `usage:${user.id}`)
  if (limited) return limited
  const perUser = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'usage-history')
  if (perUser) return perUser

  const url = new URL(req.url)
  const range = parseRange(url.searchParams.get('range'))
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json'
  const dataset = url.searchParams.get('dataset') === 'breakdown' ? 'breakdown' : 'series'

  // Optional single-session drill-down. Anything that isn't a UUID is ignored
  // rather than interpolated into a query.
  const rawCredentialId = url.searchParams.get('credential_id')
  const credentialId = rawCredentialId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCredentialId)
    ? rawCredentialId
    : undefined
  const admin = await createAdminClient()
  const { creds, truncated } = await loadScopedCredentials(admin, user.id, credentialId)

  if (creds.length === 0) {
    if (format === 'csv') {
      return csvResponse(toCsv([], [{ header: 'no_data', value: () => '' }]), `globproxy-usage-${dataset}`)
    }
    return NextResponse.json({ range_days: range, series: [], breakdown: [], credentials_truncated: false })
  }

  const dateTo = new Date()
  const dateFrom = new Date(dateTo.getTime() - range * 24 * 60 * 60 * 1000)

  // Per-credential calls, not a single ".all" call — each is independently
  // try/caught (mirrors syncUserUsage's per-credential loop in
  // lib/usageSync.ts) so one credential erroring on Geonode's side (e.g. a
  // sub-user deleted upstream but not yet reconciled locally) doesn't blank
  // out the whole page for every other credential that's fine.
  const seriesResults = await Promise.allSettled(
    creds.map(c => getPeriodStats(c.upstream_username!, dateFrom, dateTo, 'day'))
  )
  const perCredentialSeries: PeriodStat[][] = []
  let anySeriesFailure = false
  for (const r of seriesResults) {
    if (r.status === 'fulfilled') perCredentialSeries.push(r.value)
    else { anySeriesFailure = true; console.error('getPeriodStats failed for a credential:', r.reason) }
  }

  const breakdownResults = await Promise.allSettled(
    creds.map(c => getHostCountryStatsWithMeta(c.upstream_username!, dateFrom, dateTo, 'day', 500, HOST_COUNTRY_HARD_CAP))
  )
  const perCredentialBreakdown: { label: string; stats: HostCountryStat[] }[] = []
  let anyBreakdownFailure = false
  let breakdownTruncated = false
  creds.forEach((c, i) => {
    const r = breakdownResults[i]
    if (r.status === 'fulfilled') {
      perCredentialBreakdown.push({ label: c.label || c.country || 'Unnamed', stats: r.value.stats })
      if (r.value.truncated) breakdownTruncated = true
    } else {
      anyBreakdownFailure = true
      console.error('getHostCountryStatsWithMeta failed for a credential:', r.reason)
    }
  })

  // Every single credential erroring (not just some) means the upstream
  // call itself is broken, not just spotty data — surface that as an
  // error rather than a suspiciously-empty chart.
  if (perCredentialSeries.length === 0 && perCredentialBreakdown.length === 0) {
    const firstError = seriesResults.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
    return geonodeStatsErrorResponse(firstError?.reason)
  }

  const series = mergeSeries(perCredentialSeries, dateFrom, dateTo)
  const breakdown = buildBreakdown(perCredentialBreakdown)

  if (format === 'csv') {
    if (dataset === 'series') {
      const csv = toCsv(series, [
        { header: 'date', value: r => r.date },
        { header: 'gb_used', value: r => r.gb.toFixed(3) },
      ])
      return csvResponse(csv, 'globproxy-usage-daily')
    }
    const csv = toCsv(breakdown, [
      { header: 'session_label', value: r => r.label },
      { header: 'host', value: r => r.host },
      { header: 'country', value: r => r.country },
      { header: 'gb_used', value: r => r.gb.toFixed(3) },
      { header: 'requests', value: r => r.requests },
      { header: 'success_rate_pct', value: r => r.successRate.toFixed(2) },
    ])
    return csvResponse(csv, 'globproxy-usage-by-host-country')
  }

  return NextResponse.json({
    range_days: range,
    date_from: dateFrom.toISOString(),
    date_to: dateTo.toISOString(),
    series,
    // Table stays readable in-app; the CSV export carries every row we
    // fetched. That is bounded per credential (HOST_COUNTRY_HARD_CAP) — it
    // used to be described as "not capped", which was false — and
    // breakdown_truncated says when a cap was actually hit.
    breakdown: breakdown.slice(0, 50),
    breakdown_row_count: breakdown.length,
    breakdown_truncated: breakdownTruncated,
    credentials_truncated: truncated,
    partial_data: anySeriesFailure || anyBreakdownFailure,
  })
}
