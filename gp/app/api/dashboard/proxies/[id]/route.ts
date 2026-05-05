import { createClient } from '@/lib/supabase/server'
import { deleteSubUser } from '@/lib/geonode'
import { NextResponse } from 'next/server'

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
  if (cred.created_by && cred.created_by !== user.id) {
    return NextResponse.json({
      error: 'This allocation was made by your reseller and cannot be deleted. Contact them directly.',
    }, { status: 403 })
  }

  // Delete from Geonode (best effort — don't fail if API is down)
  if (cred.geonode_username) {
    try { await deleteSubUser(cred.geonode_username) }
    catch (e) { console.error('Geonode delete failed (non-fatal):', e) }
  }

  // Return GB to user's account
  const { data: bw } = await supabase
    .from('bandwidth_accounts')
    .select('used_gb')
    .eq('user_id', user.id)
    .single()

  if (bw) {
    const newUsed = Math.max(0, (bw.used_gb ?? 0) - (cred.gb_allocated ?? 0))
    await supabase.from('bandwidth_accounts')
      .update({ used_gb: newUsed })
      .eq('user_id', user.id)
  }

  // Delete the credential row
  const { error: delErr } = await supabase
    .from('proxy_credentials')
    .delete()
    .eq('id', id)

  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    gb_returned: cred.gb_allocated,
  })
}
