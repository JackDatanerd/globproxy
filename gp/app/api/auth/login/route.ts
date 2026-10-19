import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimited } from '@/lib/rateLimit'
import { verifyTurnstile, captchaOptions } from '@/lib/turnstile'
import { throttleHit, throttleClear, THROTTLE_MSG } from '@/lib/authThrottle'
import { recordLogin, sendNewDeviceNotice, sendLoginThrottleNotice, logSecurityEvent } from '@/lib/securityEvents'
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

  // Per-ACCOUNT throttle on top of the per-IP limiter: 10 attempts / 15 min
  // per email address no matter how many IPs the guesses come from. The
  // counter is cleared by a successful sign-in. The response is identical for
  // existing and non-existing addresses.
  const gate = await throttleHit('login', email, 10, 15 * 60)
  if (gate !== 'ok') {
    if (gate === 'blocked_first') {
      // One alert per window to the real owner (if there is one).
      try {
        const adm = await createAdminClient()
        const { data: owner } = await adm.from('profiles').select('id, email, full_name').eq('email', email.trim().toLowerCase()).maybeSingle()
        if (owner?.id && owner.email && owner.email !== '[deleted]') {
          await logSecurityEvent({ userId: owner.id, event: 'login_throttled', req, admin: adm })
          await sendLoginThrottleNotice(owner.email, owner.full_name, req.headers.get('cf-connecting-ip'))
        }
      } catch (e) { console.error('[auth/login] throttle alert failed', e) }
    }
    return NextResponse.json({ error: THROTTLE_MSG, code: 'throttled' }, { status: 429 })
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

  await throttleClear('login', email)

  const admin = await createAdminClient()
  const { data: profile } = await admin
    .from('profiles')
    .select('email, full_name, is_suspended, is_deleted')
    .eq('id', data.user.id)
    .maybeSingle()

  // Refuse to hand out a session to a suspended/deleted account at all,
  // instead of issuing one and relying on the next page load to kick it out.
  if (profile?.is_deleted || profile?.is_suspended) {
    await supabase.auth.signOut().catch(() => {})
    return NextResponse.json(
      { error: profile.is_deleted ? 'This account has been deleted.' : 'Your account has been suspended. Contact support@globproxy.com.',
        code: profile.is_deleted ? 'deleted' : 'suspended' },
      { status: 403 }
    )
  }

  const { newDevice, ip, ua } = await recordLogin(data.user.id, req)
  if (newDevice && data.user.email) {
    await sendNewDeviceNotice(data.user.email, profile?.full_name, ip, ua)
  }

  return NextResponse.json({ ok: true })
}
