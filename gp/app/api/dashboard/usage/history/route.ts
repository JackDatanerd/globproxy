import { createClient } from '@/lib/supabase/server'
import { getPeriodStats, getHostCountryStats, GeonodeApiError, type PeriodStat, type HostCountryStat } from '@/lib/geonode'
import { toCsv, csvResponse } from '@/lib/csv'
import { NextResponse } from 'next/server'

// Only two ranges are exposed in the UI — keeping the allowed set closed
// (rather than accepting any integer) means every call this route ever
// makes stays comfortably under Geonode's 720-unit-at-granularity=day cap
// and under Cloudflare Workers' per-invocation subrequest budget (see the
// credential cap below).
const ALLOWED_RANGE_DAYS = [7, 30] as const
type RangeDays = (typeof ALLOWED_RANGE_DAYS)[number]

function parseRange(value: string | null): RangeDays {
  const n = Number(value)
  return (ALLOWED_RANGE_DAYS as readonly number[]).includes(n) ? (n as RangeDays) : 7
}

// Each credential in scope costs up to 2 upstream calls (period + host-
// country). Cloudflare Workers' free-plan cap is 50 subrequests per
// invocation — the same ceiling that forced listAllSubUsersUsage() into a
// bulk/paginated shape for the cron sync job (see lib/geonode.ts). A
// single user's usage-history page load isn't the cron job, but a power
// user with dozens of credentials could still trip it, so this caps how
// many credentials get included and biases toward the ones that matter:
// sorted by gb_used desc, so the heaviest consumers are always covered
// even if some long-tail low/no-usage credentials get left out.
const MAX_CREDENTIALS = 15

type CredRow = {
  id: string
  label: string | null
  geonode_username: string | null
  country: string | null
  gb_used: number | null
}

async function loadScopedCredentials(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data } = await supabase
    .from('proxy_credentials')
    .select('id, label, geonode_username, country, gb_used')
    .eq('user_id', userId)
    .not('geonode_username', 'is', null)
    .order('gb_used', { ascending: false })
    .limit(MAX_CREDENTIALS)

  const { count: totalCount } = await supabase
    .from('proxy_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .not('geonode_username', 'is', null)

  const creds = (data ?? []) as CredRow[]
  return { creds, truncated: (totalCount ?? creds.length) > creds.length }
}

// Merges each credential's own per-period time series into a single
// account-level series keyed by day. There's no ".all scoped to just this
// user" option on Geonode's per-period endpoint — subUserFilter is either
// one username or every sub-user on the whole reseller account — so this
// is the only way to get an account-scoped (not reseller-wide) daily
// total across a user's multiple credentials.
function mergeSeries(perCredential: PeriodStat[][]): { date: string; gb: number }[] {
  const byDate = new Map<string, number>()
  for (const series of perCredential) {
    for (const point of series) {
      const date = point.periodStart.slice(0, 10) // YYYY-MM-DD
      const bytes = byDate.get(date) ?? 0
      byDate.set(date, bytes + point.bandwidthBytes)
    }
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bytes]) => ({ date, gb: Math.round((bytes / 1024 / 1024 / 1024) * 1000) / 1000 }))
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

  const url = new URL(req.url)
  const range = parseRange(url.searchParams.get('range'))
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json'
  const dataset = url.searchParams.get('dataset') === 'breakdown' ? 'breakdown' : 'series'

  const { creds, truncated } = await loadScopedCredentials(supabase, user.id)

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
    creds.map(c => getPeriodStats(c.geonode_username!, dateFrom, dateTo, 'day'))
  )
  const perCredentialSeries: PeriodStat[][] = []
  let anySeriesFailure = false
  for (const r of seriesResults) {
    if (r.status === 'fulfilled') perCredentialSeries.push(r.value)
    else { anySeriesFailure = true; console.error('getPeriodStats failed for a credential:', r.reason) }
  }

  const breakdownResults = await Promise.allSettled(
    creds.map(c => getHostCountryStats(c.geonode_username!, dateFrom, dateTo, 'day'))
  )
  const perCredentialBreakdown: { label: string; stats: HostCountryStat[] }[] = []
  let anyBreakdownFailure = false
  creds.forEach((c, i) => {
    const r = breakdownResults[i]
    if (r.status === 'fulfilled') {
      perCredentialBreakdown.push({ label: c.label || c.country || 'Unnamed', stats: r.value })
    } else {
      anyBreakdownFailure = true
      console.error('getHostCountryStats failed for a credential:', r.reason)
    }
  })

  // Every single credential erroring (not just some) means the upstream
  // call itself is broken, not just spotty data — surface that as an
  // error rather than a suspiciously-empty chart.
  if (perCredentialSeries.length === 0 && perCredentialBreakdown.length === 0) {
    const firstError = seriesResults.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
    return geonodeStatsErrorResponse(firstError?.reason)
  }

  const series = mergeSeries(perCredentialSeries)
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
    // Table stays readable in-app; full detail is always available via
    // the CSV export (format=csv&dataset=breakdown), which is not capped.
    breakdown: breakdown.slice(0, 50),
    breakdown_row_count: breakdown.length,
    credentials_truncated: truncated,
    partial_data: anySeriesFailure || anyBreakdownFailure,
  })
}
