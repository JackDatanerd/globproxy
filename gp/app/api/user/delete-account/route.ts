import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { sendEmailSafe } from '@/lib/email'
import { requireStepUp } from '@/lib/reauth'
import { logSecurityEvent } from '@/lib/securityEvents'
import { rejectCrossSite } from '@/lib/apiAuth'
import { deletionScheduledEmail } from '@/lib/accountDeletionEmail'
import { scheduledAtFor, DELETION_COOL_OFF_DAYS } from '@/lib/deletionSchedule'

// Self-service deletion is ALWAYS scheduled, behind the step-up (password / authenticator):
//
//   DELETE → SCHEDULE the deletion for DELETION_COOL_OFF_DAYS from now. Nothing changes
//            until then; the owner is e-mailed at once and again a day before and can
//            cancel from Settings (POST ./cancel). The hourly 'deletions' task carries it
//            out. There is deliberately NO "delete now" switch: it used to exist
//            ({ immediate: true }) and let anyone holding a signed-in browser and the second
//            factor erase the account and its proxies in one request, which is exactly what
//            the cool-off is there to prevent. Urgent erasure goes through support / admin.
export async function DELETE(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross
  try {
    // Step 1: Verify requesting user
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Each attempt can fan out to the proxy supplier's API and (on success) sends an
    // email; a stuck or looping client must not be able to hammer either.
    const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'delete-account')
    if (throttled) return throttled

    // 2FA step-up — account deletion is irreversible, so an enrolled account
    // needs a verified session, not just a password. See lib/mfa.ts.
    const mfaGate = await requireStepUp(req, user.id)
    if (mfaGate) return mfaGate

    const adminSupabase = await createAdminClient()

    // Step 2: Fetch the profile
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (!profile) return NextResponse.json({ error: 'Could not verify your account right now. Please try again.' }, { status: 503 })
    if (profile.is_deleted) {
      return NextResponse.json({ error: 'Account already deleted.' }, { status: 400 })
    }

    // A suspended account cannot erase itself: the purge removes the sign-in records
    // (IP / user-agent) that a fraud or dispute review relies on. Urgent erasure goes through support.
    if (profile.is_suspended) {
      return NextResponse.json({ error: 'This account is suspended. Contact support@globproxy.com to request deletion.' }, { status: 403 })
    }

    // ── Schedule it ───────────────────────────────────────────────────
    if (profile.deletion_scheduled_at) {
      return NextResponse.json({ success: true, scheduled: true, already: true, scheduled_at: profile.deletion_scheduled_at, cool_off_days: DELETION_COOL_OFF_DAYS })
    }
    const now = new Date()
    const when = scheduledAtFor(now)
    // Conditional on nothing being scheduled yet: a double click answers with the
    // schedule the first click made instead of pushing the date out.
    const { data: set, error: setErr } = await adminSupabase.from('profiles').update({
      deletion_requested_at: now.toISOString(),
      deletion_scheduled_at: when.toISOString(),
      deletion_reminder_sent_at: null,
      deletion_attempts: 0,
      deletion_last_error: null,
      deletion_last_attempt_at: null,
    }).eq('id', user.id).or('is_deleted.is.null,is_deleted.eq.false').is('deletion_scheduled_at', null).select('deletion_scheduled_at')
    if (setErr) {
      console.error('delete-account: could not schedule', setErr)
      return NextResponse.json({ error: 'Could not schedule the deletion. Please try again.' }, { status: 500 })
    }
    // Zero rows means a concurrent request scheduled it first (answer with THEIR date) or nothing
    // matched. Never invent a date the database does not hold: it used to answer success, and
    // send no e-mail, for a deletion that was never recorded.
    let scheduledAt = set?.[0]?.deletion_scheduled_at as string | undefined
    if (!scheduledAt) {
      const { data: now } = await adminSupabase.from('profiles').select('deletion_scheduled_at').eq('id', user.id).maybeSingle()
      scheduledAt = now?.deletion_scheduled_at ?? undefined
      if (!scheduledAt) return NextResponse.json({ error: 'Could not schedule the deletion. Please try again.' }, { status: 500 })
    }
    if (set?.length) {
      await logSecurityEvent({ userId: user.id, event: 'account_delete_scheduled', req, meta: { scheduled_at: scheduledAt }, admin: adminSupabase })
      if (profile.email && !String(profile.email).startsWith('[')) {
        const mail = deletionScheduledEmail(profile.full_name, scheduledAt)
        const sent = await sendEmailSafe({ to: profile.email, ...mail })
        if (!sent) console.error('delete-account: scheduling e-mail was not delivered', user.id)
      }
    }
    return NextResponse.json({ success: true, scheduled: true, scheduled_at: scheduledAt, cool_off_days: DELETION_COOL_OFF_DAYS })

  } catch (err: any) {
    console.error('delete-account unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
