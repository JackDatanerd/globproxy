import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = await createAdminClient()

  // Fetch credential — verify ownership
  const { data: cred } = await admin
    .from('proxy_credentials')
    .select('user_id, gb_allocated')
    .eq('id', id)
    .single()

  if (!cred) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (cred.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Return GB to user's bandwidth account
  const { data: bw } = await admin
    .from('bandwidth_accounts')
    .select('used_gb')
    .eq('user_id', user.id)
    .single()

  await admin
    .from('bandwidth_accounts')
    .update({ used_gb: Math.max(0, (bw?.used_gb ?? 0) - cred.gb_allocated) })
    .eq('user_id', user.id)

  // Delete the credential
  await admin.from('proxy_credentials').delete().eq('id', id)

  return NextResponse.json({ success: true })
}
