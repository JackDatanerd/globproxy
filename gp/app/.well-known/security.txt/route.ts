// RFC 9116 security.txt. Gives researchers (and abuse reporters) one standard place
// to find who to tell. The contact is the public support mailbox the site already
// publishes; set SECURITY_CONTACT_EMAIL to route reports elsewhere without a code
// change. `Expires` is rolled forward on every request (one year out), so the file
// can never go stale and be ignored by tooling that treats an expired file as absent.
export const dynamic = 'force-dynamic'

function origin(req: Request): string {
  try {
    if (process.env.NEXT_PUBLIC_APP_URL) return new URL(process.env.NEXT_PUBLIC_APP_URL).origin
  } catch { /* fall through to the request's own origin */ }
  return new URL(req.url).origin
}

export async function GET(req: Request) {
  const contact = (process.env.SECURITY_CONTACT_EMAIL ?? '').trim() || 'support@globproxy.com'
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
  const body = [
    `Contact: mailto:${contact}`,
    `Expires: ${expires}`,
    'Preferred-Languages: en',
    `Canonical: ${origin(req)}/.well-known/security.txt`,
    '',
  ].join('\n')
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
