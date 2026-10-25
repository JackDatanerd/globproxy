import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimited, clientKey } from '@/lib/rateLimit'
import { verifyTurnstile, captchaOptions } from '@/lib/turnstile'
import { throttleHit, throttleClear, THROTTLE_MSG, THROTTLE_ACCOUNT_MSG } from '@/lib/authThrottle'
import { recordLogin, recordAndNotify, isKnownLoginIp, requestMeta } from '@/lib/securityEvents'
import { recordSessionDevice, sessionIdFromJwt } from '@/lib/sessionDevices'
import { bindVerifiedSessionToAuthSession, getMfaCookieFromRequest } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// Server-side sign-in. The login page used to call
// supabase.auth.signInWithPassword() straight from the browser, which meant
// no app-level rate limit, no bot check, and no place to hook "new device"
// notices or an audit trail. Going through the cookie-aware ssr client here
// sets the very same session cookies the browser client reads, so the rest
// of the app is unaffected.
//
// NOTE: the Supabase anon key is public, so this route cannot stop someone
// calling Supabase's /token endpoint directly. For that, also enable
// "Attack protection → CAPTCHA" and rate limits in the Supabase dashboard.
export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'login')
  if (limited) return limited

  const { email, password, turnstileToken } = await req.json().catch(() => ({}))
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
  }
  if (email.length > 320 || password.length > 1024) {
    return NextResponse.json({ error: 'Invalid login credentials' }, { status: 400 })
  }

  const human = await verifyTurnstile(req, turnstileToken)
  if (!human.ok) return NextResponse.json({ error: human.error, code: 'captcha_failed' }, { status: 400 })

  // Two layers on top of the per-IP limiter, deliberately NOT a plain
  // per-account lockout (that would let anyone who can send ten requests keep
  // the real owner out forever):
  //  1. account + connection: 10 attempts / 15 min. Only the connection that
  //     kept guessing is paused; the owner on their own network is untouched.
  //  2. account-wide ceiling: 40 / 15 min across every connection. Past it the
  //     owner is alerted and only connections the account has signed in from
  //     before may keep trying, so a botnet can't grind passwords and a
  //     stranger can't lock the owner out.
  const norm = email.trim().toLowerCase()
  const conn = clientKey(req) ?? 'noip'
  const gate = await throttleHit('login', `${norm}|${conn}`, 10, 15 * 60)
  if (gate !== 'ok') return NextResponse.json({ error: THROTTLE_MSG, code: 'throttled' }, { status: 429 })

  const acctGate = await throttleHit('loginacct', norm, 40, 15 * 60)
  if (acctGate !== 'ok') {
    if (acctGate === 'blocked_first') {
      // One alert per window to the real owner (if there is one).
      try {
        const adm = await createAdminClient()
        const { data: owner } = await adm.from('profiles').select('id, email, full_name').eq('email', norm).maybeSingle()
        if (owner?.id && owner.email && owner.email !== '[deleted]') {
          await recordAndNotify({ userId: owner.id, event: 'login_throttled', req, admin: adm })
        }
      } catch (e) { console.error('[auth/login] throttle alert failed', e) }
    }
    if (!(await isKnownLoginIp(norm, requestMeta(req).ip))) {
      return NextResponse.json({ error: THROTTLE_ACCOUNT_MSG, code: 'throttled' }, { status: 429 })
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
    options: captchaOptions(turnstileToken),
  })

  if (error || !data.user) {
    const msg = error?.message ?? 'Invalid login credentials'
    // GoTrue only reports "not confirmed" AFTER the password checked out, so
    // this reveals nothing to someone who doesn't already hold the password.
    if (/not confirmed/i.test(msg)) {
      return NextResponse.json({ error: 'Please confirm your email address first.', code: 'email_not_confirmed' }, { status: 403 })
    }
    // A deleted account is banned in GoTrue; show the same friendly message
    // the profile check below would have, not GoTrue's raw "User is banned".
    if (/banned/i.test(msg)) {
      return NextResponse.json({ error: 'This account has been deleted or disabled. Contact support@globproxy.com.', code: 'deleted' }, { status: 403 })
    }
    const status = error?.status && error.status >= 400 && error.status < 500 ? error.status : 400
    return NextResponse.json({ error: msg }, { status: status === 429 ? 429 : 400 })
  }

  await throttleClear('login', `${norm}|${conn}`)

  const admin = await createAdminClient()
  const { data: profile } = await admin
    .from('profiles')
    .select('email, full_name, is_suspended, is_deleted')
    .eq('id', data.user.id)
    .maybeSingle()

  // Refuse to hand out a session to a suspended/deleted account at all,
  // instead of issuing one and relying on the next page load to kick it out.
  if (profile?.is_deleted || profile?.is_suspended) {
    // Local scope: a global sign-out here would also end the owner's other devices.
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
    return NextResponse.json(
      { error: profile.is_deleted ? 'This account has been deleted.' : 'Your account has been suspended. Contact support@globproxy.com.',
        code: profile.is_deleted ? 'deleted' : 'suspended' },
      { status: 403 }
    )
  }

  await recordSessionDevice(data.user.id, data.session?.access_token, req)
  // A browser that already holds a verified/trusted 2FA cookie keeps using it under
  // this new login session — remember that, so signing this device out from
  // Settings later also ends its 2FA trust.
  await bindVerifiedSessionToAuthSession(data.user.id, getMfaCookieFromRequest(req), sessionIdFromJwt(data.session?.access_token))
  // A device / country the account hasn't signed in from lately is e-mailed to the owner
  // (durably — see recordAndNotify) from inside recordLogin.
  await recordLogin(data.user.id, req)

  return NextResponse.json({ ok: true })
}
