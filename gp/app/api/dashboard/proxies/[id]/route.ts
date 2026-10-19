import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { deleteOwnCredential } from '@/lib/credentials'
import { NextResponse } from 'next/server'

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Every other write route in this app gates on this — this one didn't.
  // Low-impact either way (deleting your own credential only frees a
  // reservation back to your own balance, it doesn't grant anything new),
  // but left inconsistent it's an easy thing to trip over later when
  // reasoning about "does suspension actually block everything."
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params

  // Fetch credential — verify ownership
  const { data: cred, error: fetchErr } = await supabase
    .from('proxy_credentials')
    .select('*')
    .eq('id', id)
    .single()

  if (fetchErr || !cred) {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  }

  // Only the direct owner can delete
  if (cred.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Block deletion if this credential was created by a reseller for a client
  // Resellers cannot reverse allocations — clients paid them for this bandwidth
  if (cred.created_by) {
    return NextResponse.json({
      error: 'This allocation was made by your reseller and cannot be deleted. Contact them directly.',
    }, { status: 403 })
  }

  const result = await deleteOwnCredential(user.id, cred)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ success: true })
}
