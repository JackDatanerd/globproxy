import { requireApiAccess } from '@/lib/apiAuth'
import { deleteSubUser, getSubUserUsage } from '@/lib/geonode'
import { NextResponse } from 'next/server'

// Mirrors app/api/dashboard/proxies/[id]/route.ts's DELETE handler as
// closely as possible — same ownership rule, same partial-usage release
// logic, same used-GB archiving — just authenticated via an API key
// (requireApiAccess) instead of a browser session. See that file for the
// full history of why each of these steps exists; not re-explained here
// to avoid the two copies drifting out of sync on the reasoning while
// still keeping the reasoning discoverable from wherever someone lands.
export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  const { id } = await context.params

  try {
    const { data: cred, error: fetchErr } = await supabase
      .from('proxy_credentials')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (fetchErr || !cred) {
      return NextResponse.json({ error: 'Sub-user not found' }, { status: 404 })
    }

    // Bandwidth a reseller allocated to a client can't be reversed by the
    // client via the API any more than it can from their dashboard — the
    // reseller paid for it.
    if (cred.created_by && cred.created_by !== user.id) {
      return NextResponse.json({
        error: 'This allocation was made by your reseller and cannot be deleted. Contact them directly.',
      }, { status: 403 })
    }

    let liveUsedGb: number | null = null
    if (cred.geonode_sub_user_id) {
      try { liveUsedGb = await getSubUserUsage(cred.geonode_sub_user_id) }
      catch (e) { console.error('[v1 delete] Live usage check failed (non-fatal):', e) }
    }

    if (cred.geonode_sub_user_id) {
      try { await deleteSubUser(cred.geonode_sub_user_id) }
      catch (e) { console.error('[v1 delete] Geonode delete failed (non-fatal):', e) }
    }

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

    const usedGb = liveUsedGb ?? cred.gb_used ?? 0
    const releaseGb = Math.max(0, cred.gb_allocated - usedGb)

    const { error: releaseErr } = await supabase.rpc('release_credential_bandwidth', {
      p_user_id: user.id,
      p_gb: releaseGb,
    })
    if (releaseErr) console.error('[v1 delete] Failed to release bandwidth reservation:', releaseErr)

    if (usedGb > 0) {
      const { error: archiveErr } = await supabase.rpc('archive_credential_used_gb', {
        p_user_id: user.id,
        p_gb: usedGb,
      })
      if (archiveErr) console.error('[v1 delete] Failed to archive consumed bandwidth:', archiveErr)
    }

    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('[v1 DELETE sub-user] unexpected error:', e)
    return NextResponse.json({ error: 'Internal error. Please try again.' }, { status: 500 })
  }
}
