import { createAdminClient } from '@/lib/supabase/server'
import { rateLimited } from '@/lib/rateLimit'
import { REF_COOKIE, REF_SUB_COOKIE, REF_COOKIE_MAX_AGE_S, cleanReferralCode, cleanSubId } from '@/lib/referralAttribution'
import { NextResponse } from 'next/server'

// Short, trackable referral link: /r/CODE[?sub=campaign].
// Counts the click, sets the 60-day first-party attribution cookie, and
// forwards to signup (keeping ?ref= so the page works even if cookies are off).
export async function GET(req: Request, context: { params: Promise<{ code: string }> }) {
  const { code: rawCode } = await context.params
  const code = cleanReferralCode(rawCode)
  const url = new URL(req.url)
  const dest = new URL('/auth/signup', url.origin)

  if (!code) return NextResponse.redirect(dest)

  const sub = cleanSubId(url.searchParams.get('sub'))
  dest.searchParams.set('ref', code)
  if (sub) dest.searchParams.set('sub', sub)

  const res = NextResponse.redirect(dest)

  // First touch wins: don't replace an existing attribution cookie.
  const existing = req.headers.get('cookie') ?? ''
  const hasCookie = new RegExp(`(?:^|;\\s*)${REF_COOKIE}=`).test(existing)
  if (!hasCookie) {
    const opts = { maxAge: REF_COOKIE_MAX_AGE_S, path: '/', sameSite: 'lax' as const, secure: url.protocol === 'https:' }
    res.cookies.set(REF_COOKIE, code, opts)
    if (sub) res.cookies.set(REF_SUB_COOKIE, sub, opts)
  }

  // Click counting is best-effort and rate-limited per IP so it can't be
  // used to inflate an affiliate's numbers cheaply — and it must never
  // delay or break the redirect.
  try {
    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'ref-click')
    if (!limited) {
      const admin = await createAdminClient()
      const { error } = await admin.rpc('record_referral_click', { p_code: code, p_sub_id: sub })
      if (error) console.error('[ref] click record failed', error)
    }
  } catch (e) {
    console.error('[ref] click record threw', e)
  }

  return res
}
