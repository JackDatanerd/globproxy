import { withApiAuth, failFrom, asApiRateLimited, readJsonBody } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { cancelInvitation, reduceInvitation } from '@/lib/resellerAllocation'
import { NextResponse } from 'next/server'

// DELETE /api/v1/reseller/invitations/:id — withdraw an invitation nobody has claimed
// yet; the reserved stock returns to your available balance at once. Needs the
// "allocate" scope (the same key, pinned to the same addresses, that created it).
// Answers 404 once the invitation was claimed, cancelled or expired, so a retry
// after a timeout is safe: it can never return stock twice.
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'DELETE invitation', async ({ user, supabase }) => {
    const { id } = await context.params
    const limited = (await rateLimited(req, 'RESELLER_RATE_LIMITER', `invite-cancel:${user.id}`)) ?? (await rateLimitedUser('RESELLER_RATE_LIMITER', user.id, 'invite-cancel'))
    if (limited) return asApiRateLimited(limited)

    const { data: profile } = await supabase.from('profiles').select('email, full_name').eq('id', user.id).maybeSingle()
    const r = await cancelInvitation(supabase, { id: user.id, email: profile?.email, full_name: profile?.full_name }, id, 'api')
    if (!r.ok) return r.status === 400 ? apiError(404, 'not_found', 'Invitation not found') : failFrom(r)
    return NextResponse.json({ success: true, returned_gb: r.data.returned_gb })
  }, { scope: 'allocate' })
}

// PATCH /api/v1/reseller/invitations/:id  { "gb": 10 } — lower the amount reserved on an
// invitation nobody has claimed (the difference returns to your stock at once). The
// expiry and reminder count are unchanged. To raise it, allocate to the address again;
// to remove it, DELETE. Needs the "allocate" scope. Idempotent: repeating the same body
// answers 400 ("enter a smaller amount") instead of returning stock twice.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'PATCH invitation', async ({ user, supabase }) => {
    const { id } = await context.params
    const limited = (await rateLimited(req, 'RESELLER_RATE_LIMITER', `invite-reduce:${user.id}`)) ?? (await rateLimitedUser('RESELLER_RATE_LIMITER', user.id, 'invite-reduce'))
    if (limited) return asApiRateLimited(limited)
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const { data: profile } = await supabase.from('profiles').select('email, full_name, role').eq('id', user.id).maybeSingle()
    if (!profile || !['reseller', 'admin'].includes(profile.role ?? '')) return apiError(403, 'reseller_required', 'Reseller access required.')
    const r = await reduceInvitation(supabase, { id: user.id, email: profile.email, full_name: profile.full_name }, id, (json.body as any)?.gb)
    if (!r.ok) return r.status === 400 && !/smaller amount|Enter the new amount/.test(r.message) ? apiError(404, 'not_found', 'Invitation not found') : failFrom(r)
    return NextResponse.json({ success: true, gb: r.data.gb, returned_gb: r.data.returned_gb })
  }, { scope: 'allocate' })
}
