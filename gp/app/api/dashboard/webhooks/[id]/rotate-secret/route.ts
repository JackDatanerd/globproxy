import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rotateSecret } from '@/lib/webhookEndpoints'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// Replaces the signing secret; the old one stops working immediately and
// the new one is returned once, in this response.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 2FA step-up, same as webhook create/update: rotating the signing secret
  // is a security-sensitive change. See lib/mfa.ts.
  const mfaGate = await requireMfaVerified(req, user.id)
  if (mfaGate) return mfaGate

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const r = await rotateSecret(await createAdminClient(), user.id, id)
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  return NextResponse.json({ id: r.data.id, secret: r.data.secret })
}
