import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { bannerSummary } from '@/lib/broadcastRules'

// The signed-in customer's active dashboard announcements: broadcasts that were addressed to THEIR
// account (a recipient row exists), asked for a banner, have not ended and have not been withdrawn.
// Read with the service role (the broadcast tables have no customer-facing policies) but scoped to the
// caller's own id, which comes from the session — never from the request.
export async function GET() {
  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = await createAdminClient()
  const { data: mine, error } = await admin.from('broadcast_recipients').select('broadcast_id').eq('user_id', user.id).limit(200)
  if (error) return NextResponse.json({ userId: user.id, items: [] }) // cosmetic: never break the dashboard over a banner
  const ids = (mine ?? []).map(r => r.broadcast_id)
  if (!ids.length) return NextResponse.json({ userId: user.id, items: [] }, { headers: { 'Cache-Control': 'no-store' } })

  const { data: rows } = await admin.from('broadcasts')
    .select('id, kind, subject, body, cta_label, cta_url, banner_ends_at')
    .in('id', ids).eq('show_banner', true).neq('status', 'cancelled').gt('banner_ends_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(3)

  return NextResponse.json({
    userId: user.id,
    items: (rows ?? []).map(b => ({
      id: b.id, kind: b.kind, title: b.subject, text: bannerSummary(b.body),
      cta_label: b.cta_label, cta_url: b.cta_url, ends_at: b.banner_ends_at,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
