import { requireApiAccess } from '@/lib/apiAuth'
import { updateSubUserTrafficLimit } from '@/lib/geonode'
import { NextResponse } from 'next/server'

// Mirrors app/api/dashboard/proxies/[id]/topup/route.ts — same atomic
// reserve-and-bump RPC, same Geonode PATCH-after-commit ordering. See
// that file for the full rationale.
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  const { id } = await context.params

  try {
    const body = await req.json().catch(() => ({}))
    const gb_amount = Number(body?.gb_amount)

    if (!gb_amount || gb_amount <= 0) {
      return NextResponse.json({ error: 'gb_amount must be greater than 0' }, { status: 400 })
    }

    // requireApiAccess already returns the service-role admin client — same
    // one topup_credential() needs, no separate admin lookup required here
    // the way the dashboard route needs a second createAdminClient() call
    // (that route authenticates with the session client first).
    const { data: rawNewTotal, error: topupErr } = await supabase.rpc('topup_credential', {
      p_credential_id: id,
      p_user_id: user.id,
      p_gb: gb_amount,
    })

    if (topupErr) {
      const msg = topupErr.message ?? 'Top-up failed'
      const status =
        msg.includes('Insufficient') ? 402 :
        topupErr.code === 'P0002' || msg.includes('not found') ? 404 :
        msg.includes('reseller') ? 403 :
        400
      return NextResponse.json({ error: msg }, { status })
    }

    const newTotal = Number(rawNewTotal)

    const { data: cred } = await supabase
      .from('proxy_credentials')
      .select('status, geonode_sub_user_id')
      .eq('id', id)
      .single()

    if (cred?.status === 'active' && cred.geonode_sub_user_id && Number.isFinite(newTotal)) {
      try {
        await updateSubUserTrafficLimit(cred.geonode_sub_user_id, newTotal * 1024)
      } catch (e) {
        console.error('[v1 topup] DB committed but Geonode PATCH failed — needs manual reconciliation', id, e)
        return NextResponse.json({
          success: true,
          gb_allocated: newTotal,
          warning: 'Your balance was reserved and this sub-user\u2019s allocation was increased, but updating the live proxy limit failed. If it doesn\u2019t resolve shortly, contact support.',
        })
      }
    }

    return NextResponse.json({ success: true, gb_allocated: newTotal })
  } catch (e: any) {
    console.error('[v1 topup] unexpected error:', e)
    return NextResponse.json({ error: 'Internal error. Please try again.' }, { status: 500 })
  }
}
