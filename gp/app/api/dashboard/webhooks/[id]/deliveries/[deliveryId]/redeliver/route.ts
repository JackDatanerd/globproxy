import { requireMfaVerified } from '@/lib/mfa'
import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { redeliverWebhook } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

// Re-sends a stored delivery (same event id + body, fresh signature timestamp).
export async function POST(req: Request, context: { params: Promise<{ id: string; deliveryId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id, deliveryId } = await context.params
  const r = await redeliverWebhook(user.id, deliveryId, id)
  if (r.error === 'Delivery not found' || r.error === 'Webhook not found') {
    return NextResponse.json({ error: r.error }, { status: 404 })
  }
  if (!r.ok) return NextResponse.json({ error: r.error ?? 'Delivery failed' }, { status: 502 })
  return NextResponse.json({ success: true })
}
