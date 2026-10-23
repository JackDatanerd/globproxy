import { withApiAuth, parsePage } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'
import { ROSTER_MAX_PAGE, parseRosterFilter, parseRosterSort } from '@/lib/reseller'

// GET /api/v1/reseller/clients?q=acme&filter=unused&sort=used&limit=50&offset=0
// Your client roster — one row per account you have sent bandwidth to, with what
// they were sent, what was reclaimed and how much of that they have used. The same
// data as the dashboard's Sub-users page and its CSV export, so an integration can
// reconcile balances without scraping. `q` is a case-insensitive contains-match on
// email or name. `filter` is all | unused | exhausted | idle and `sort` is recent |
// sent | used | remaining | name (default: newest activity first). `limit` is
// capped at 100 — the most the roster query returns in one call.
export async function GET(req: Request) {
  return withApiAuth(req, 'GET reseller clients', async ({ user, supabase }) => {
    const url = new URL(req.url)
    const { limit, offset } = parsePage(url, { limit: 50, max: ROSTER_MAX_PAGE })
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100)
    const filter = parseRosterFilter(url.searchParams.get('filter'))
    const sort = parseRosterSort(url.searchParams.get('sort'))

    const { data, error } = await supabase.rpc('reseller_client_roster', {
      p_reseller_id: user.id, p_search: q || null, p_limit: limit, p_offset: offset, p_filter: filter, p_sort: sort,
    })
    if (error) {
      console.error('[v1 GET reseller clients] roster failed', error)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    const rows = (data as any[] | null) ?? []
    const num = (v: unknown) => (v == null ? null : Math.round(Number(v) * 1000) / 1000)
    // `total_count` rides on every row, so it is unknown only when the page is empty.
    const total = rows.length ? Number(rows[0].total_count) : offset === 0 ? 0 : null

    return NextResponse.json({
      clients: rows.map((r) => ({
        // A deleted account is not named any more.
        email: r.is_deleted ? null : r.email,
        name: r.is_deleted ? null : r.full_name ?? null,
        account: r.is_deleted ? 'deleted' : r.is_suspended ? 'suspended' : 'active',
        transfers: Number(r.transfer_count),
        gb_sent: num(r.total_received_gb),
        gb_reclaimed: num(r.total_reclaimed_gb),
        gb_net: num(Number(r.total_received_gb) - Number(r.total_reclaimed_gb)),
        gb_used: num(r.client_used_gb),
        gb_unassigned: num(r.client_available_gb),
        last_transfer_at: r.last_transfer_at ?? null,
        last_note: r.last_note ?? null,
      })),
      total, limit, offset,
      has_more: total !== null && offset + rows.length < total,
    })
  })
}
