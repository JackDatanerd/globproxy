import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Only ever allow redirecting somewhere on our own site. A bare query param
// like `next` must never be trusted as-is — `next=https://evil.com@x` or
// `next=//evil.com` are both valid open-redirect payloads that would send an
// authenticated user off-platform straight from a trusted globproxy.com link.
// Anything that doesn't look like a single internal path falls back to
// '/dashboard'.
function safeNextPath(raw: string | null): string {
  if (!raw) return '/dashboard'
  // Must start with exactly one '/', never '//' (protocol-relative) or a
  // backslash (some URL parsers normalise '\' to '/'), and must not contain
  // '@' (host-confusion trick: "https://real-origin@evil.com") or a scheme.
  if (!/^\/(?!\/)[^\s\\]*$/.test(raw)) return '/dashboard'
  if (raw.includes('@') || raw.includes('://')) return '/dashboard'
  return raw
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const type = searchParams.get('type')
  const next = safeNextPath(searchParams.get('next'))

  if (code) {
    const s = await createClient()
    const { data, error } = await s.auth.exchangeCodeForSession(code)

    if (error) {
      return NextResponse.redirect(`${origin}/auth/login?error=link_expired`)
    }

    // signup/route.ts stores intended_role: 'reseller' in auth user_metadata
    // for the "Apply to resell" signup variant, but nothing downstream ever
    // read it back — the profiles row it creates always defaults to
    // role:'user' with reseller_status:null, so that signup silently became
    // an ordinary account with no application on file. The actual working
    // application flow lives in app/api/auth/apply-reseller/route.ts,
    // reachable from Settings, and needs fields (country, phone, monthly
    // volume) the signup form never collected — so redirect there with the
    // form pre-opened instead of trying to submit an application here with
    // incomplete data. Only do this when the caller didn't ask for a
    // specific `next` destination, and only if there isn't already an
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

  // --- FIX: Prevent Hash Stripping on Password Reset ---
  if (type === 'recovery') {
    if (!code) {
      // If there's no code, it means we are using implicit flow with a #hash.
      // A standard 302 redirect will drop the hash. We use an HTML redirect instead.
      return new NextResponse(`
        <html><body><script>
          window.location.href = '${origin}/auth/update-password' + window.location.hash;
        </script></body></html>
      `, { headers: { 'Content-Type': 'text/html' } })
    }
    return NextResponse.redirect(`${origin}/auth/update-password`)
  }

  if (type === 'email_change') {
    return NextResponse.redirect(`${origin}/dashboard/settings?success=email_updated`)
  }

  if (type === 'invite') {
    return NextResponse.redirect(`${origin}/auth/update-password`)
  }

  return NextResponse.redirect(`${origin}${next}`)
}