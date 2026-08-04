import { createClient } from '@/lib/supabase/server'
import { deleteSubUser, getSubUserUsage } from '@/lib/geonode'
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

  // Check live usage BEFORE deleting the Geonode sub-user — once it's
  // deleted, its usage may no longer be queryable. This number is what
  // determines how much of the reservation gets released back below.
  let liveUsedGb: number | null = null
  if (cred.geonode_sub_user_id) {
    try { liveUsedGb = await getSubUserUsage(cred.geonode_sub_user_id) }
    catch (e) { console.error('Live usage check failed (non-fatal, will fall back to synced gb_used):', e) }
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
  // deleting a self-owned credential should give the *unused portion* of
  // that reservation back (see the usedGb/releaseGb calculation below —
  // giving back the full amount regardless of consumption was the
  // delete-then-recreate bandwidth reclaim bug). This only applies to credentials this user created for themselves
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

  // Release only what's actually unused. Previously released the FULL
  // gb_allocated regardless of consumption — this was a live, exploitable
  // revenue leak: buy 10GB, allocate a 10GB credential, use 9GB of real
  // traffic through Geonode, delete it (reclaims the full 10GB), create a
  // new 10GB credential — ~19GB of real usage extracted from a 10GB
  // purchase. Prefer the live Geonode check fetched above (accurate to
  // API-call latency); fall back to the last cron-synced gb_used column if
  // that call failed, rather than blocking the delete over it.
  const usedGb = liveUsedGb ?? cred.gb_used ?? 0
  const releaseGb = Math.max(0, cred.gb_allocated - usedGb)

  const { error: releaseErr } = await supabase.rpc('release_credential_bandwidth', {
    p_user_id: user.id,
    p_gb: releaseGb,
  })
  if (releaseErr) console.error('Failed to release bandwidth reservation on delete:', releaseErr)

  return NextResponse.json({ success: true })
}
