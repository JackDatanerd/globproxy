import { withApiAuth, parsePage, pagedQuery } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'

// GET /api/v1/reseller/invitations?status=pending&limit=50&offset=0
// Invitations created when you allocated to an address with no confirmed account
// yet (POST /reseller/allocations answers status "pending_signup" with a pending_id).
// The stock is reserved until the invitee signs up (then it lands), you cancel
// (DELETE /reseller/invitations/:id) or it expires after 30 days. Without `status`
// every state from the last 90 days is returned, newest first.
const STATUSES = ['pending', 'claimed', 'cancelled', 'expired']

export async function GET(req: Request) {
  return withApiAuth(req, 'GET invitations', async ({ user, supabase }) => {
    const url = new URL(req.url)
    const { limit, offset } = parsePage(url, { limit: 50, max: 200 })
    const status = url.searchParams.get('status')
    if (status && !STATUSES.includes(status)) {
      return apiError(400, 'invalid_request', `status must be one of: ${STATUSES.join(', ')}.`)
    }
    const build = () => {
    let q = supabase
      .from('reseller_pending_transfers')
      .select('id, recipient_email, gb_amount, note, status, created_at, expires_at, resolved_at', { count: 'exact' })
      .eq('reseller_id', user.id)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
    if (status) q = q.eq('status', status)
    return q
    }

    const { data, count, error } = await pagedQuery(build, offset, limit)
    if (error) {
      console.error('[v1 GET invitations] query failed', error)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    const total = count ?? (data?.length ?? 0)
    return NextResponse.json({
      invitations: (data ?? []).map((r: any) => ({
        id: r.id, recipient_email: r.recipient_email, gb: Number(r.gb_amount), note: r.note ?? null,
        status: r.status, created_at: r.created_at, expires_at: r.expires_at, resolved_at: r.resolved_at ?? null,
      })),
      total, limit, offset,
      has_more: offset + (data?.length ?? 0) < total,
    })
  })
}
