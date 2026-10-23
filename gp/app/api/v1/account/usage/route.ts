import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'

// GET /api/v1/account/usage?days=30
// Account-wide daily data usage (GB, UTC days) for the last `days` days (1–365,
// default 30), oldest first, with zero-filled gaps. Served from our own ledger, so
// it is cheap and covers deleted sub-users too — unlike per-sub-user history
// (/sub-users/:id/usage/history), which is limited to 10 calls a minute. The ledger
// is updated by usage syncs every few minutes; `first_recorded_day` says where it
// begins (days before it read 0 because nothing was recorded, not because nothing
// was used).
export async function GET(req: Request) {
  return withApiAuth(req, 'GET account usage', async ({ user, supabase }) => {
    const url = new URL(req.url)
    const raw = url.searchParams.get('days')
    const days = raw === null || raw === '' ? 30 : Number(raw)
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return apiError(400, 'invalid_request', 'days must be a whole number from 1 to 365.')
    }

    const DAY = 86_400_000
    const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
    const start = today - (days - 1) * DAY
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10)

    const [{ data: rows, error }, { data: first }] = await Promise.all([
      supabase.from('usage_daily').select('day, gb').eq('user_id', user.id).gte('day', iso(start)).lte('day', iso(today)),
      supabase.from('usage_daily').select('day').eq('user_id', user.id).order('day', { ascending: true }).limit(1),
    ])
    if (error) {
      console.error('[v1 GET account usage] query failed', error)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    const byDay = new Map<string, number>((rows ?? []).map((r: any) => [String(r.day), Number(r.gb)]))
    const series: { date: string; gb: number }[] = []
    let total = 0
    for (let t = start; t <= today; t += DAY) {
      const gb = Math.round((byDay.get(iso(t)) ?? 0) * 10000) / 10000
      total += gb
      series.push({ date: iso(t), gb })
    }
    return NextResponse.json({
      from: iso(start), to: iso(today), days,
      total_gb: Math.round(total * 10000) / 10000,
      first_recorded_day: first?.[0]?.day ? String(first[0].day) : null,
      usage: series,
    })
  })
}
