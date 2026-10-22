import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getDelivery } from '@/lib/webhookEndpoints'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// One delivery in full (event body + the receiver's response snippet).
export async function GET(req: Request, context: { params: Promise<{ id: string; deliveryId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  // Delivery bodies carry event payloads: same 2FA step-up as the webhook routes.
  const mfaGate = await requireMfaVerified(req, user.id)
  if (mfaGate) return mfaGate

  const { id, deliveryId } = await context.params
  const r = await getDelivery(await createAdminClient(), user.id, id, deliveryId)
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  return NextResponse.json(r.data)
}
