import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { safeNextPath } from '@/lib/safeNext'
import { RECOVERY_COOKIE_NAME, RECOVERY_TTL_S, makeRecoveryCookieValue } from '@/lib/recoveryCookie'

// Marks THIS session as having just arrived via an emailed link (recovery or
// invite), so /api/auth/password lets it set a new password without the
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
      const dest = type === 'recovery' ? '/auth/reset' : '/auth/login'
      return NextResponse.redirect(`${origin}${dest}?error=link_expired${type === 'recovery' ? '' : '&kind=confirm'}`)
    }

    // `type` is just a query parameter anyone can add to a link. It only
    // decides what the visitor is shown; it must never be what grants the
    // "arrived by e-mail proof" cookie (set a new password with no current
    // password and no 2FA). The cookie is minted only when GoTrue's own record
    // agrees that a recovery / invite e-mail was sent to this account
    // recently, which a code from an ordinary sign-in or confirmation link
    // can't satisfy.
    if (data.user && (type === 'recovery' || type === 'invite')) {
      const stamp = type === 'recovery' ? data.user.recovery_sent_at : data.user.invited_at
      const maxAgeMs = type === 'recovery' ? 2 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
      const sentAt = stamp ? new Date(stamp).getTime() : NaN
      if (Number.isFinite(sentAt) && Date.now() - sentAt <= maxAgeMs) {
        recoveryUserId = data.user.id
      } else {
        console.error('[auth/callback] refused', type, 'proof: no recent e-mail of that kind on this account')
        await s.auth.signOut({ scope: 'local' }).catch(() => {})
        const dest = type === 'recovery' ? '/auth/reset' : '/auth/login'
        return NextResponse.redirect(`${origin}${dest}?error=link_expired`)
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
    return NextResponse.redirect(`${origin}/dashboard/settings?success=email_updated`)
  }

  if (type === 'invite') {
    // An invited user is setting their very first password — same
    // email-proof situation as a recovery link.
    return withEmailProofCookie(NextResponse.redirect(`${origin}/auth/update-password`), recoveryUserId)
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
