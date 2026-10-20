import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { listDeliveries } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'

// Delivery log for one endpoint (last 14 days).
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const { id } = await context.params
  const url = new URL(req.url)
  const r = await listDeliveries(await createAdminClient(), user.id, id, {
    limit: Number(url.searchParams.get('limit')) || undefined,
    status: url.searchParams.get('status'),
  })
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  return NextResponse.json({ deliveries: r.data })
}
