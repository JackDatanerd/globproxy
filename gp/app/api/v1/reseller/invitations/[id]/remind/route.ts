import { withApiAuth, failFrom, asApiRateLimited } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { remindInvitation } from '@/lib/resellerAllocation'
import { NextResponse } from 'next/server'

// POST /api/v1/reseller/invitations/:id/remind — e-mail the invitee again about an
// invitation nobody has claimed yet. One reminder per 24 hours (429 until then) and
// at most three per invitation (409 after that). Needs the "allocate" scope.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST invitation remind', async ({ user, supabase }) => {
    const { id } = await context.params
    const limited = (await rateLimited(req, 'RESELLER_RATE_LIMITER', `invite-remind:${user.id}`)) ?? (await rateLimitedUser('RESELLER_RATE_LIMITER', user.id, 'invite-remind'))
    if (limited) return asApiRateLimited(limited)

    const { data: profile } = await supabase.from('profiles').select('email, full_name').eq('id', user.id).maybeSingle()
    const r = await remindInvitation(supabase, { id: user.id, email: profile?.email, full_name: profile?.full_name }, id)
    if (!r.ok) return r.status === 400 ? apiError(404, 'not_found', 'Invitation not found') : failFrom(r)
    return NextResponse.json({ success: true, reminders_left: r.data.reminders_left, expires_at: r.data.expires_at })
  }, { scope: 'allocate' })
}
