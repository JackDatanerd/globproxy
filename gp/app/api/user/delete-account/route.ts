import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { performAccountDeletion, countInFlightPayments } from '@/lib/accountDeletion'
import { rateLimitedUser } from '@/lib/rateLimit'
import { sendEmailSafe } from '@/lib/email'
import { requireStepUp } from '@/lib/reauth'
import { logSecurityEvent } from '@/lib/securityEvents'
import { rejectCrossSite } from '@/lib/apiAuth'
import { deletionCompleteEmail, deletionScheduledEmail } from '@/lib/accountDeletionEmail'
import { scheduledAtFor, DELETION_COOL_OFF_DAYS } from '@/lib/deletionSchedule'

// Two ways to leave, both behind the same step-up (password / authenticator):
//
//   DELETE {}                    → SCHEDULE the deletion for DELETION_COOL_OFF_DAYS from
//                                  now. Nothing changes until then; the owner is e-mailed
//                                  at once and again a day before and can cancel from
//                                  Settings (POST ./cancel). The hourly 'deletions' task
//                                  carries it out. Anyone who got hold of a signed-in
//                                  browser and the second factor can no longer erase the
//                                  account — and its proxies — in one request.
//   DELETE { immediate: true }   → delete now (the original behaviour).
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

    const body = await req.json().catch(() => ({})) as { immediate?: unknown }
    const immediate = body?.immediate === true

    const adminSupabase = await createAdminClient()

    // Step 2: Fetch profile before wiping it
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (!profile) return NextResponse.json({ error: 'Could not verify your account right now. Please try again.' }, { status: 503 })
    if (profile.is_deleted) {
      return NextResponse.json({ error: 'Account already deleted.' }, { status: 400 })
    }

    // ── Scheduled deletion ────────────────────────────────────────────
    if (!immediate) {
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
      }).eq('id', user.id).eq('is_deleted', false).is('deletion_scheduled_at', null).select('deletion_scheduled_at')
      if (setErr) {
        console.error('delete-account: could not schedule', setErr)
        return NextResponse.json({ error: 'Could not schedule the deletion. Please try again.' }, { status: 500 })
      }
      const scheduledAt = set?.[0]?.deletion_scheduled_at ?? when.toISOString()
      if (set?.length) {
        await logSecurityEvent({ userId: user.id, event: 'account_delete_scheduled', req, meta: { scheduled_at: scheduledAt }, admin: adminSupabase })
        if (profile.email && !String(profile.email).startsWith('[')) {
          const mail = deletionScheduledEmail(profile.full_name, scheduledAt)
          const sent = await sendEmailSafe({ to: profile.email, ...mail })
          if (!sent) console.error('delete-account: scheduling e-mail was not delivered', user.id)
        }
      }
      return NextResponse.json({ success: true, scheduled: true, scheduled_at: scheduledAt, cool_off_days: DELETION_COOL_OFF_DAYS })
    }

    // ── Immediate deletion ────────────────────────────────────────────
    // A payment that is still in flight would be credited to this account AFTER it is
    // closed (the webhook / reconcile cannot tell), and nobody would be refunded.
    // Ask the person to let it settle first.
    const flight = await countInFlightPayments(adminSupabase, user.id)
    if (flight.error) {
      console.error('delete-account: could not check in-flight payments', flight.error)
      return NextResponse.json({ error: 'Could not verify your account right now. Please try again.' }, { status: 503 })
    }
    if (flight.count > 0) {
      return NextResponse.json(
        { error: 'A payment on your account is still being processed. Please wait a few minutes for it to finish, then try again — deleting now would lose it.', code: 'payment_in_flight' },
        { status: 409 }
      )
    }

    // The signed-in browser's own session: needed to revoke every session of this
    // account (the admin signOut API is keyed on a JWT of the account's owner, which
    // THIS route — unlike the admin one — actually holds).
    const { data: { session: callerSession } } = await supabase.auth.getSession()

    // Claim → ban → release every upstream sub-user → purge, all in lib/accountDeletion
    // (one implementation shared with the admin route and the scheduled run).
    const result = await performAccountDeletion(adminSupabase, user.id, { before: profile, accessToken: callerSession?.access_token ?? null })
    if (!result.ok) {
      console.error('delete-account: deletion aborted at', result.stage, result.error)
      switch (result.stage) {
        case 'already_deleted':
          return NextResponse.json({ error: 'Account already deleted.' }, { status: 409 })
        case 'list':
          return NextResponse.json({ error: 'Could not verify your account right now. Please try again.' }, { status: 503 })
        case 'release':
          // Every sub-user must really be gone before the account is finalised: a failure
          // here has already rolled the claim and the ban back, so the account is intact
          // (sessions that WERE released stay dead and are settled).
          return NextResponse.json(
            { error: 'We could not remove your proxy sessions right now, so your account was not deleted. Please try again in a few minutes.' },
            { status: 502 }
          )
        default:
          return NextResponse.json({ error: 'Could not delete the account. Please try again.' }, { status: 500 })
      }
    }

    // Audit trail: a bare tombstone (no IP / user-agent — it is written after the purge
    // precisely so it is the only record left), written once the deletion has actually
    // committed: when it was written first, a refused attempt still left an entry.
    await logSecurityEvent({ userId: user.id, event: 'account_deleted', admin: adminSupabase })

    // Step 7: Email — best-effort, non-fatal, but awaited and checked (the response is
    // returned right after, and an un-awaited send can be cancelled on Workers).
    if (profile.email && profile.email !== '[deleted]') {
      const mail = deletionCompleteEmail(profile.full_name)
      const sent = await sendEmailSafe({ to: profile.email, ...mail })
      if (!sent) console.error('delete-account: confirmation e-mail was not delivered', user.id)
    }

    return NextResponse.json({ success: true, message: 'Account deleted' })

  } catch (err: any) {
    console.error('delete-account unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
