import { requireApiAccess } from '@/lib/apiAuth'
import { deleteOwnCredential } from '@/lib/credentials'
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
    if (cred.created_by) {
      return NextResponse.json({
        error: 'This allocation was made by your reseller and cannot be deleted. Contact them directly.',
      }, { status: 403 })
    }

    const result = await deleteOwnCredential(user.id, cred)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('[v1 DELETE sub-user] unexpected error:', e)
    return NextResponse.json({ error: 'Internal error. Please try again.' }, { status: 500 })
  }
}
