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
  // Start from the (few) live banner broadcasts, newest first, then keep the ones addressed to this
  // account. Reading the account's recipient rows first and capping them was unordered, so an account
  // with many past broadcasts could lose its newest banner to the cap.
  const { data: live, error } = await admin.from('broadcasts')
    .select('id, kind, subject, body, cta_label, cta_url, banner_ends_at')
    .eq('show_banner', true).neq('status', 'cancelled').gt('banner_ends_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(50)
  if (error) return NextResponse.json({ userId: user.id, items: [] }) // cosmetic: never break the dashboard over a banner
  const liveIds = (live ?? []).map(b => b.id)
  if (!liveIds.length) return NextResponse.json({ userId: user.id, items: [] }, { headers: { 'Cache-Control': 'no-store' } })

  const { data: mine, error: mineErr } = await admin.from('broadcast_recipients').select('broadcast_id').eq('user_id', user.id).in('broadcast_id', liveIds)
  if (mineErr) return NextResponse.json({ userId: user.id, items: [] })
  const addressed = new Set((mine ?? []).map(r => r.broadcast_id))
  const rows = (live ?? []).filter(b => addressed.has(b.id)).slice(0, 3)

  return NextResponse.json({
    userId: user.id,
    items: rows.map(b => ({
      id: b.id, kind: b.kind, title: b.subject, text: bannerSummary(b.body),
      cta_label: b.cta_label, cta_url: b.cta_url, ends_at: b.banner_ends_at,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
