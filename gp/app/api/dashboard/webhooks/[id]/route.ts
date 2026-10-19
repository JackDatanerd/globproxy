import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { updateEndpoint, deleteEndpoint } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'
import { requireStepUp } from '@/lib/reauth'

// Ownership is enforced inside lib/webhookEndpoints.ts by scoping every
// write to user_id (RLS can't run the SSRF guard — see migration 0018).
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 2FA step-up: an account that enabled two-factor must hold a verified
  // session for this action — a password alone isn't enough. See lib/mfa.ts.
  const mfaGate = await requireStepUp(req, user.id)
  if (mfaGate) return mfaGate


  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const r = await updateEndpoint(await createAdminClient(), user.id, id, body)
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  return NextResponse.json({ webhook: r.data })
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const r = await deleteEndpoint(await createAdminClient(), user.id, id)
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  return NextResponse.json({ success: true })
}
