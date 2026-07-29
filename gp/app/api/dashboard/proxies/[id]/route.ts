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

  // Delete from Geonode (best effort — don't fail if API is down).
  // Geonode's delete endpoint takes the sub-user ID, not the username —
  // using geonode_username here silently orphaned the sub-user on every
  // deletion (see lib/bandwidth.ts / cron usage-sync, which use the
  // correct field).
  if (cred.geonode_sub_user_id) {
    try { await deleteSubUser(cred.geonode_sub_user_id) }
    catch (e) { console.error('Geonode delete failed (non-fatal):', e) }
  }

  // NOTE: we intentionally do NOT manually adjust bandwidth_accounts.used_gb
  // here. used_gb tracks actual bytes consumed (synced from Geonode by the
  // cron usage job), not the credential's gb_allocated cap — those are
  // different numbers. Subtracting gb_allocated from used_gb over- or
  // under-refunds the account depending on how much of the allocation was
  // actually used, and the next usage-sync cron run overwrites it anyway.
  // The account's real available balance is unaffected by deleting an
  // unused/under-used credential's cap.

  // Delete the credential row
  const { error: delErr } = await supabase
    .from('proxy_credentials')
    .delete()
    .eq('id', id)

  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
