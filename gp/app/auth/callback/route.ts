import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { safeNextPath } from '@/lib/safeNext'
import { RECOVERY_COOKIE_NAME, RECOVERY_TTL_S, makeRecoveryCookieValue } from '@/lib/recoveryCookie'
import { recordSessionDevice, sessionIdFromJwt } from '@/lib/sessionDevices'
import { bindVerifiedSessionToAuthSession, getMfaCookieFromRequest } from '@/lib/mfa'
import { recordLogin } from '@/lib/securityEvents'

// Marks THIS session as having just arrived via an emailed recovery link, so /api/auth/password lets it set a new password without the
// current one. See lib/recoveryCookie.ts.
async function withEmailProofCookie(res: NextResponse, userId: string | null): Promise<NextResponse> {
  if (userId) {
    res.cookies.set(RECOVERY_COOKIE_NAME, await makeRecoveryCookieValue(userId), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: RECOVERY_TTL_S,
    })
  }
  return res
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const type = searchParams.get('type')
  const next = safeNextPath(searchParams.get('next'))

  let recoveryUserId: string | null = null
  let emailChangePending = false

  if (code) {
    const s = await createClient()
    const { data, error } = await s.auth.exchangeCodeForSession(code)

    if (error) {
      // The most common cause here isn't the link actually expiring — it's
      // the PKCE code_verifier cookie being gone. That cookie is a single
      // fixed name per browser, overwritten by every subsequent
      // resetPasswordForEmail()/signUp()/etc. call, so only the most
      // recently requested recovery/signup link in a given browser can
      // ever be exchanged. Same symptom if the link is opened in a
      // different browser/device than the one that submitted the form.
      //
      // For a SIGNUP link that matters less than it sounds: GoTrue confirms
      // the address when the link is first opened, BEFORE redirecting here,
      // so the email is very likely already confirmed even though this
      // browser can't pick up the session. The login page says so.
      console.error('[auth/callback] exchangeCodeForSession failed', { type, error: error.message })
      // Each link type gets its own explanation on the login page: the signup wording ("opening it
      // usually already confirmed your email … resend the confirmation") is wrong for an
      // email-change link.
      const dest = type === 'recovery' ? '/auth/reset' : '/auth/login'
      const kind = type === 'recovery' ? '' : type === 'email_change' ? '&kind=email_change' : '&kind=confirm'
      return NextResponse.redirect(`${origin}${dest}?error=link_expired${kind}`)
    }

    // `type` is just a query parameter anyone can add to a link. It only
    // decides what the visitor is shown; it must never be what grants the
    // "arrived by e-mail proof" cookie (set a new password with no current
    // password and no 2FA). The cookie is minted only when GoTrue's own record
    // agrees that a recovery e-mail was sent to this account recently — and
    // "recently" is GoTrue's own one-hour link lifetime plus slack, so the
    // stamp (which GoTrue never clears) can't be borrowed for long. There is
    // no invite flow in this app, so an `invite` type is just a normal link.
    if (data.user && type === 'recovery') {
      const sentAt = data.user.recovery_sent_at ? new Date(data.user.recovery_sent_at).getTime() : NaN
      if (Number.isFinite(sentAt) && Date.now() - sentAt <= 65 * 60 * 1000) {
        recoveryUserId = data.user.id
      } else {
        console.error('[auth/callback] refused recovery proof: no recent recovery e-mail on this account')
        await s.auth.signOut({ scope: 'local' }).catch(() => {})
        return NextResponse.redirect(`${origin}/auth/reset?error=link_expired`)
      }
    }

    // Signup confirmation completed in the SAME browser that requested it (the
    // code exchange needs this browser's PKCE verifier AND the e-mailed code):
    // the password chosen at signup is trustworthy, so hand it back. A link
    // opened anywhere else never reaches here, and that account keeps the
    // placeholder password until its owner uses "Forgot password" — see
    // migration 0060. Never for a recovery link (the password is about to be
    // replaced). Best effort: failing leaves the safe state.
    if (data.user && type !== 'recovery') {
      try {
        const admin = await createAdminClient()
        const { error: restoreErr } = await admin.rpc('auth_restore_pending_password', { p_user_id: data.user.id })
        if (restoreErr) console.error('[auth/callback] pending password restore failed', restoreErr.message)
      } catch (e) {
        console.error('[auth/callback] pending password restore threw', e)
      }
    }

    if (data.user && type === 'email_change') emailChangePending = !!(data.user as { new_email?: string | null }).new_email

    // The visitor's real IP / user-agent for the "Where you're signed in" card
    // (auth.sessions only has this server's).
    if (data.user) {
      await recordSessionDevice(data.user.id, data.session?.access_token, request)
      await bindVerifiedSessionToAuthSession(data.user.id, getMfaCookieFromRequest(request), sessionIdFromJwt(data.session?.access_token))
      // Signing in through an e-mailed link is a sign-in like any other: it belongs
      // in the owner's activity list, and a device the account hasn't used before
      // gets the same notice a password sign-in would.
      try {
        const via = type === 'recovery' ? 'recovery_link' : type === 'email_change' ? 'email_change_link' : 'email_link'
        await recordLogin(data.user.id, request, { via })
      } catch (e) {
        console.error('[auth/callback] login audit failed (non-fatal)', e)
      }
    }

    // signup/route.ts stores intended_role: 'reseller' in auth user_metadata
    // for the "Apply to resell" signup variant. The working application flow
    // lives in app/api/auth/apply-reseller/route.ts, reachable from
    // Settings, and needs fields the signup form never collected — so
    // redirect there with the form pre-opened. Only when the caller didn't
    // ask for a specific `next`, and only if there isn't already an
    // application/role on file (so this doesn't re-trigger on every login).
    if (!searchParams.get('next') && data.user?.user_metadata?.intended_role === 'reseller') {
      const { data: profile } = await s
        .from('profiles')
        .select('role, reseller_status')
        .eq('id', data.user.id)
        .single()
      if (profile?.role === 'user' && !profile.reseller_status) {
        return NextResponse.redirect(`${origin}/dashboard/settings?apply_reseller=1`)
      }
    }
  }

  if (type === 'recovery') {
    if (!code) {
      // A recovery link with no code is the old implicit flow (tokens in the
      // URL #hash). It is not accepted any more: update-password no longer
      // installs sessions from the hash (that was a session-fixation hole).
      return NextResponse.redirect(`${origin}/auth/reset?error=link_expired`)
    }
    return withEmailProofCookie(NextResponse.redirect(`${origin}/auth/update-password`), recoveryUserId)
  }

  if (type === 'email_change') {
    // With double confirmation the first link only confirms one side; GoTrue keeps
    // `new_email` set until both addresses have confirmed. Don't announce a change
    // that hasn't happened yet.
    return NextResponse.redirect(`${origin}/dashboard/settings?success=${emailChangePending ? 'email_pending' : 'email_updated'}`)
  }

  // A bare hit with neither a code nor a type is what the implicit-flow
  // confirmation link produces (resend-confirmation links carry no PKCE
  // challenge): the address is already confirmed, the browser just has no
  // session. Send them to sign in rather than bouncing off middleware.
  if (!code) {
    return NextResponse.redirect(`${origin}/auth/login?notice=confirmed`)
  }

  return NextResponse.redirect(`${origin}${next}`)
}
