import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { sendEmailSafe } from '@/lib/email'
import { logSecurityEvent } from '@/lib/securityEvents'
import { rejectCrossSite } from '@/lib/apiAuth'
import { deletionCancelledEmail } from '@/lib/accountDeletionEmail'

// Cancels a deletion scheduled through DELETE /api/user/delete-account. Deliberately
// NOT behind the step-up: cancelling only ever keeps the account as it is, so the person
// who owns it must be able to do it from any signed-in session (or after signing in from
// the link in the e-mail) without a second factor in the way. Idempotent.
export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'delete-account-cancel')
    if (throttled) return throttled

    const admin = await createAdminClient()
    const { data: cleared, error } = await admin.from('profiles').update({
      deletion_requested_at: null,
      deletion_scheduled_at: null,
      deletion_reminder_sent_at: null,
      deletion_attempts: 0,
      deletion_last_error: null,
    }).eq('id', user.id).eq('is_deleted', false).not('deletion_scheduled_at', 'is', null).select('email, full_name')
    if (error) {
      console.error('delete-account/cancel failed', error)
      return NextResponse.json({ error: 'Could not cancel the deletion. Please try again.' }, { status: 500 })
    }
    if (!cleared?.length) return NextResponse.json({ success: true, cancelled: false })

    await logSecurityEvent({ userId: user.id, event: 'account_delete_cancelled', req, admin })
    const p = cleared[0]
    if (p.email && !String(p.email).startsWith('[')) {
      const mail = deletionCancelledEmail(p.full_name)
      const sent = await sendEmailSafe({ to: p.email, ...mail })
      if (!sent) console.error('delete-account/cancel: e-mail was not delivered', user.id)
    }
    return NextResponse.json({ success: true, cancelled: true })
  } catch (err: any) {
    console.error('delete-account/cancel unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
