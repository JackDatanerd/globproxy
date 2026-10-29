import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyUnsubscribe } from '@/lib/unsubscribe'
import { unsubscribeSecret } from '@/lib/broadcast'

// One-click unsubscribe from product news & offers. Not cookie-authenticated: the signed link IS the
// credential (lib/unsubscribe.ts), so it works from a mail client's own "Unsubscribe" button
// (RFC 8058 — a POST with no browser session) and from the footer link.
//
//   POST /api/unsubscribe?u=<account id>&t=<signature>   performs it
//   GET  /api/unsubscribe?u=...&t=...                    sends the browser to a confirm page instead — a GET must
//                                                        never change anything, because mail scanners and link
//                                                        previews fetch every link in a message
//
// Receipts, security notices and service broadcasts are not affected.
export async function POST(req: Request) {
  const url = new URL(req.url)
  const u = url.searchParams.get('u') ?? ''
  const t = url.searchParams.get('t') ?? ''
  if (!(await verifyUnsubscribe(unsubscribeSecret(), u, t))) {
    return NextResponse.json({ error: 'This unsubscribe link is not valid.' }, { status: 400 })
  }
  const supabase = await createAdminClient()
  const { error } = await supabase.from('profiles').update({ marketing_emails: false }).eq('id', u)
  if (error) {
    console.error('[unsubscribe] update failed', error.message)
    return NextResponse.json({ error: 'Could not save that right now. Please try again.' }, { status: 500 })
  }
  // Same answer whether or not the account still exists: nothing here confirms an account to a stranger.
  return NextResponse.json({ success: true })
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const dest = new URL('/unsubscribe', url.origin)
  for (const k of ['u', 't']) { const v = url.searchParams.get(k); if (v) dest.searchParams.set(k, v) }
  return NextResponse.redirect(dest, 303)
}
