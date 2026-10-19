import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { deleteCredential } from '@/lib/credentials'
import { NextResponse } from 'next/server'

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params

  // Ownership, the reseller-allocation block, upstream-delete-must-succeed,
  // and the release/archive bookkeeping all live in lib/credentials.ts —
  // shared with DELETE /api/v1/sub-users/:id.
  const admin = await createAdminClient()
  const result = await deleteCredential(admin, user.id, id, 'dashboard')
  if (!result.ok) {
    return NextResponse.json(
      { error: result.status === 404 ? 'Credential not found' : result.message },
      { status: result.status }
    )
  }
  return NextResponse.json({ success: true })
}
