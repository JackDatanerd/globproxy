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

  // NOTE: we intentionally do NOT touch bandwidth_accounts.used_gb here.
  // used_gb tracks actual bytes consumed (synced from Geonode by the cron
  // usage job) and is a completely separate number from gb_allocated.
  //
  // gb_allocated itself, however, IS now reserved out of allocated_gb at
  // creation time (migration 0007 / reserve_credential_bandwidth) — so
  // deleting a self-owned credential should give that reservation back.
  // This only applies to credentials this user created for themselves
  // (created_by is null, enforced above); reseller-allocated ones never hit
  // this path since deletion is blocked for those a few lines up.
  //
  // The release happens AFTER the delete below is confirmed to have
  // actually removed a row — releasing it first would let a failed/blocked
  // delete free up the reservation while the credential (and its Geonode
  // cap) still exists, letting the same GB be reserved and spent twice.

  // Delete the credential row. Supabase does NOT error when RLS silently
  // blocks a delete (0 rows matched) — without .select() here, a blocked
  // delete and a real one both came back as `{ error: null }`, so this
  // endpoint could report success while leaving the row untouched.
  const { data: deletedRows, error: delErr } = await supabase
    .from('proxy_credentials')
    .delete()
    .eq('id', id)
    .select('id')

  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 })
  }
  if (!deletedRows || deletedRows.length === 0) {
    return NextResponse.json({ error: 'Delete was blocked — nothing was removed.' }, { status: 500 })
  }

  const { error: releaseErr } = await supabase.rpc('release_credential_bandwidth', {
    p_user_id: user.id,
    p_gb: cred.gb_allocated,
  })
  if (releaseErr) console.error('Failed to release bandwidth reservation on delete:', releaseErr)

  return NextResponse.json({ success: true })
}
