import { createAdminClient } from '@/lib/supabase/server'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// Payout itself happens outside the app (a manual Paystack transfer, per
// the marketing-plan discussion) — this route just records that it
// happened, same Bearer-token + MFA-gated admin pattern as every other
// /api/admin/* route.
export async function POST(req: Request) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const supabaseAdmin = await createAdminClient()
    const { data: { user } } = await supabaseAdmin.auth.getUser(token)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: adminProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single()
    if (adminProfile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const mfaCheck = await requireMfaVerified(req, user.id)
    if (mfaCheck) return mfaCheck

    const { commissionId } = await req.json()
    if (!commissionId) return NextResponse.json({ error: 'Commission ID missing' }, { status: 400 })

    const { data: existing } = await supabaseAdmin.from('affiliate_commissions').select('status').eq('id', commissionId).single()
    if (existing?.status !== 'pending') {
      return NextResponse.json({ error: 'This commission is not in a payable state.' }, { status: 409 })
    }

    const { error: updateErr } = await supabaseAdmin
      .from('affiliate_commissions')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', commissionId)

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
