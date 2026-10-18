import { createClient, createAdminClient } from '@/lib/supabase/server'
import { validateEmail } from '@/lib/email-validation'
import { rateLimited } from '@/lib/rateLimit'
import { verifyTurnstile } from '@/lib/turnstile'
import { NextResponse } from 'next/server'

// Until now a signup that never got its confirmation email (spam folder,
// typo'd inbox provider hiccup) had no way forward: the "Try again" link on
// /auth/verify went back to signup, which — to avoid leaking which emails are
// registered — answers "check your email" for an existing address WITHOUT
// sending anything. This is the real "resend" path.
//
// Same enumeration discipline as signup/reset: one fixed response whichever
// branch ran, padded to a minimum duration.
const RESPONSE_FLOOR_MS = 700

async function respond(startedAt: number) {
  const elapsed = Date.now() - startedAt
  if (elapsed < RESPONSE_FLOOR_MS) await new Promise(r => setTimeout(r, RESPONSE_FLOOR_MS - elapsed))
  return NextResponse.json({ success: true, message: "If that address is waiting for confirmation, we've sent a new link." })
}

export async function POST(req: Request) {
  const startedAt = Date.now()
  try {
    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'resend')
    if (limited) return limited

    const { email, emailRedirectTo, turnstileToken } = await req.json().catch(() => ({}))
    if (typeof email !== 'string' || !email) return NextResponse.json({ error: 'Email required' }, { status: 400 })
    const { valid, error: emailError } = validateEmail(email)
    if (!valid) return NextResponse.json({ error: emailError }, { status: 400 })

    const human = await verifyTurnstile(req, turnstileToken)
    if (!human.ok) return NextResponse.json({ error: human.error }, { status: 400 })

    let safeRedirect: string | undefined
    if (emailRedirectTo) {
      try {
        const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').origin
        if (new URL(emailRedirectTo).origin === appOrigin) safeRedirect = emailRedirectTo
      } catch { /* dropped */ }
    }

    const admin = await createAdminClient()
    const lower = email.trim().toLowerCase()

    const { data: banned } = await admin.from('banned_emails').select('id').eq('email', lower).maybeSingle()
    if (banned) return respond(startedAt)

    const { data: unconfirmed } = await admin.rpc('auth_email_unconfirmed', { check_email: lower })
    if (!unconfirmed) return respond(startedAt)

    const ssr = await createClient()
    const { error } = await ssr.auth.resend({ type: 'signup', email: lower, options: { emailRedirectTo: safeRedirect } })
    if (error) console.error('[auth/resend-confirmation] resend failed:', error.message)

    return respond(startedAt)
  } catch (err) {
    console.error('[auth/resend-confirmation] unexpected error', err)
    return respond(startedAt)
  }
}
