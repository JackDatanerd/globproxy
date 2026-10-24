import { requireMfaVerified } from '@/lib/mfa'
import { cursorTs } from '@/lib/cursor'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { listDeliveries } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/apiAuth'

// Delivery log for one endpoint (last 14 days).
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended
  const { id } = await context.params
  const url = new URL(req.url)
  const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get('limit'))) || 50, 1), 100)
  const r = await listDeliveries(await createAdminClient(), user.id, id, {
    limit,
    status: url.searchParams.get('status'), eventType: url.searchParams.get('event_type'),
    before: url.searchParams.get('before'),
    beforeId: url.searchParams.get('before_id'),
  })
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  const rows = r.data.rows
  const hasMore = r.data.has_more
  return NextResponse.json({ deliveries: rows, has_more: hasMore, next_before: hasMore ? cursorTs(rows[rows.length - 1].created_at) : null, next_before_id: hasMore ? rows[rows.length - 1].id : null })
}
