import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { anonymisedProfilePatch, rollbackProfilePatch, releaseGeonodeSubUsers, purgeAccountSecrets, listReleasableCredentials } from '@/lib/accountDeletion'
import { rateLimitedUser } from '@/lib/rateLimit'
import { sendEmail, escapeHtml } from '@/lib/email'
import { requireStepUp } from '@/lib/reauth'
import { logSecurityEvent } from '@/lib/securityEvents'
import { rejectCrossSite } from '@/lib/apiAuth'

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

    // Step 2: Fetch profile before wiping it
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (profile?.is_deleted) {
      return NextResponse.json({ error: 'Account already deleted.' }, { status: 400 })
    }

    // A payment that is still in flight would be credited to this account AFTER it is
    // closed (the webhook / reconcile cannot tell), and nobody would be refunded.
    // Ask the person to let it settle first. Pending checkouts older than two hours are
    // abandoned ones; a paid order that never got credited is always a reason to wait.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { count: inFlight, error: inFlightErr } = await adminSupabase
      .from('orders').select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).eq('bandwidth_credited', false)
      .or(`and(payment_status.eq.pending,created_at.gt.${twoHoursAgo}),payment_status.eq.paid`)
    if (inFlightErr) {
      console.error('delete-account: could not check in-flight payments', inFlightErr)
      return NextResponse.json({ error: 'Could not verify your account right now. Please try again.' }, { status: 503 })
    }
    if ((inFlight ?? 0) > 0) {
      return NextResponse.json(
        { error: 'A payment on your account is still being processed. Please wait a few minutes for it to finish, then try again — deleting now would lose it.', code: 'payment_in_flight' },
        { status: 409 }
      )
    }

    // Step 3: Clean up live Geonode sub-users before touching local rows —
    // see app/api/admin/delete-user/route.ts for the full rationale (cascade
    // from auth.users would otherwise wipe proxy_credentials with no record
    // of which Geonode sub-users need cleanup).
    // (Includes credentials that only hold a reserved provisioning identity: their
    // sub-user may exist even though its id was never saved.)
    let creds
    try { creds = await listReleasableCredentials(adminSupabase, user.id) }
    catch (e) {
      console.error('delete-account: could not list credentials', e)
      return NextResponse.json({ error: 'Could not verify your account right now. Please try again.' }, { status: 503 })
    }

    // Every sub-user must really be gone before the account is finalised: this
    // used to swallow failures, so an outage left live, usable proxies behind
    // an account marked deleted. 404 = already gone (a retry after a partial
    // run), which is fine — so this route is safe to call again. Sub-users that
    // WERE released are tombstoned locally straight away, so an abort halfway
    // through never leaves the database claiming a dead proxy is still live.
    const { failed: releaseFailed } = await releaseGeonodeSubUsers(adminSupabase, creds)
    if (releaseFailed.length) {
      return NextResponse.json(
        { error: 'We could not remove your proxy sessions right now, so your account was not deleted. Please try again in a few minutes.' },
        { status: 502 }
      )
    }

    // The signed-in browser's own session: needed below to revoke every session of
    // this account (the admin signOut API is keyed on a JWT of the account's owner,
    // which THIS route — unlike the admin one — actually holds).
    const { data: { session: callerSession } } = await supabase.auth.getSession()

    // Step 4: Anonymise. Wipes everything personal on the profile — name,
    // email, company, payout destination (wallet / bank / M-Pesa) and the
    // free-text applications — while keeping what accounting and abuse
    // handling need: orders/invoices, ledgers and the suspension state. A
    // suspended account that deletes itself stays suspended (this used to
    // clear the suspension fields, turning self-deletion into an unsuspend).
    const { error: profileError } = await adminSupabase
      .from('profiles')
      .update(anonymisedProfilePatch())
      .eq('id', user.id)

    if (profileError) {
      console.error('delete-account: profile anonymise failed', profileError)
      return NextResponse.json({ error: 'Could not delete the account. Please try again.' }, { status: 500 })
    }

    // Step 5: Ban rather than delete the auth account — deleting it would
    // cascade and remove the anonymised profile row (and everything hanging
    // off it) we just wrote, and throw an FK error for accounts with
    // reseller_transfers history. See admin/delete-user/route.ts.
    //
    // The ban blocks future sign-ins and refreshes, but an access token
    // issued moments before this runs is a stateless JWT — Supabase has no
    // API to revoke one before it naturally expires (only refresh tokens
    // can be revoked, and only via that token owner's own JWT, which
    // isn't something admin/delete-user/route.ts holds — this self-service
    // route does, and revokes with it below). middleware.ts's is_deleted check
    // (migration 0029) is what actually closes that window: it blocks
    // /dashboard, /reseller, /admin, and /invoice for this profile on the
    // very next request regardless of whether the access token itself is
    // technically still "valid".
    // Revoke every refresh token / session of the account. Done BEFORE the ban (a banned
    // user's token may no longer be accepted by the sign-out endpoint). The ban blocks
    // refreshes and middleware blocks the pages; this also ends the sessions themselves,
    // so no other device keeps a live session on a closed account. Best-effort: if the
    // ban below fails the person simply has to sign in again.
    if (callerSession?.access_token) {
      try {
        const { error: outErr } = await adminSupabase.auth.admin.signOut(callerSession.access_token, 'global')
        if (outErr) console.error('[delete-account] global sign-out failed', user.id, outErr.message)
      } catch (e) { console.error('[delete-account] global sign-out threw', user.id, e) }
    }

    const { error: banError } = await adminSupabase.auth.admin.updateUserById(user.id, {
      ban_duration: '876000h',
    })

    if (banError) {
      // Rollback anonymisation (everything the update above cleared)
      await adminSupabase.from('profiles').update(rollbackProfilePatch(profile ?? {})).eq('id', user.id)
      console.error('delete-account: ban failed', banError)
      return NextResponse.json({ error: 'Could not delete the account. Please try again.' }, { status: 500 })
    }

    // Steps 6-6b: credentials tombstoned, webhooks / 2FA seeds / sign-in history /
    // request logs removed, API keys revoked, affiliate side stopped. ONE shared
    // implementation with the admin delete route (lib/accountDeletion.ts) — this
    // route used to carry its own copy, which had already drifted (it never
    // cleared the API request log or sign-in history). Runs after the ban, so
    // the rollback path above never has to restore any of it.
    const purge = await purgeAccountSecrets(adminSupabase, user.id)
    if (purge.warnings.length) console.error('[delete-account] cleanup warnings', user.id, purge.warnings)

    // Audit trail: a bare tombstone (no IP / user-agent — it is written after
    // the purge precisely so it is the only record left). Written once the
    // deletion has actually committed (anonymised + banned): when it was
    // written first, a refused or failed attempt still left an entry behind.
    await logSecurityEvent({ userId: user.id, event: 'account_deleted', admin: adminSupabase })

    // Step 7: Email — best-effort, non-fatal
    if (profile?.email && profile.email !== '[deleted]') {
      await sendEmail({
        to: profile.email,
        subject: 'Your GlobProxy account has been deleted',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Account deleted</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(profile.full_name) || 'there'}, your GlobProxy account has been permanently
              deleted as requested. Your name, payout details and proxy credentials have been removed and the account can no longer be signed in to. The sign-in email address is kept on a disabled record so the account can&rsquo;t be re-registered or reactivated. Records of past payments are kept as required for accounting.
            </p>
            <p style="color:#444;text-align:center;">
              If you did not request this, please contact us immediately.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="mailto:support@globproxy.com"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Contact support →
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © ${new Date().getFullYear()} GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
      }).catch(() => {})
    }

    return NextResponse.json({ success: true, message: 'Account deleted' })

  } catch (err: any) {
    console.error('delete-account unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
