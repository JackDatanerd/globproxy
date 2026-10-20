import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireMfaVerified } from '@/lib/mfa'
import { rateLimited } from '@/lib/rateLimit'
import { sendEmail, escapeHtml } from '@/lib/email'
import { cleanNumber } from '@/lib/validation'
import { isUuid } from '@/lib/adminAuth'
import { formatGb } from '@/lib/format'
import { NextResponse } from 'next/server'

// Take back the UNUSED part of a transfer (typo'd email, cancelled order…).
// Only bandwidth the client has not used or committed to a credential, and
// has not since topped up past, can move back — and only within
// RECLAIM_WINDOW_DAYS of the transfer. reclaim_reseller_allocation() enforces
// all of that under row locks.
export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase.from('profiles').select('role, email, full_name').eq('id', user.id).single()
    if (!['reseller', 'admin'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
    }
    const mfaCheck = await requireMfaVerified(req, user.id)
    if (mfaCheck) return mfaCheck
    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive
    const limited = await rateLimited(req, 'RESELLER_RATE_LIMITER', `reclaim:${user.id}`)
    if (limited) return limited

    let body: any
    try { body = await req.json() } catch { body = null }
    const transferId = isUuid(body?.transfer_id) ? body.transfer_id : null
    if (!transferId) return NextResponse.json({ error: 'transfer_id is required' }, { status: 400 })

    let gb: number | null = null
    if (body?.gb !== undefined && body?.gb !== null && body?.gb !== '') {
      gb = cleanNumber(body.gb)
      if (gb === null || gb <= 0 || Math.abs(gb * 1000 - Math.round(gb * 1000)) > 1e-6) {
        return NextResponse.json({ error: 'Enter a positive amount with at most 3 decimal places' }, { status: 400 })
      }
    }

    const admin = await createAdminClient()
    const { data, error } = await admin.rpc('reclaim_reseller_allocation', {
      p_transfer_id: transferId,
      p_reseller_id: user.id,
      p_gb: gb,
    })
    if (error) {
      const msg = error.message ?? ''
      if (msg.includes('Nothing to reclaim') || msg.includes('Nothing left')) return NextResponse.json({ error: msg.replace(/^.*?: /, '') }, { status: 409 })
      if (msg.includes('not found')) return NextResponse.json({ error: 'Transfer not found' }, { status: 404 })
      console.error('[reseller/reclaim] RPC failed', error)
      return NextResponse.json({ error: 'Could not reclaim this transfer.' }, { status: 500 })
    }
    const row = Array.isArray(data) ? data[0] : data
    const reclaimed = Number(row?.out_reclaimed_gb ?? 0)

    // Tell the client their bandwidth was reduced — silent clawbacks are how
    // support tickets get created. Best-effort.
    const { data: transfer } = await admin
      .from('reseller_transfers').select('recipient:recipient_id(email, full_name)').eq('id', transferId).single()
    const recipient = transfer?.recipient as any
    if (recipient?.email && !String(recipient.email).startsWith('[')) {
      await sendEmail({
        to: recipient.email,
        subject: `${formatGb(reclaimed)} of unused bandwidth was returned to your reseller`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <h2 style="text-align:center;color:#111;">Unused bandwidth returned</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(recipient.full_name?.split(' ')[0]) || 'there'}, <strong>${escapeHtml(formatGb(reclaimed))}</strong> of
              unused bandwidth that ${escapeHtml(profile?.full_name) || 'your reseller'} had transferred to you was returned to them.
              Bandwidth you've already used, assigned to a proxy, or bought yourself is never touched. Questions? Reply to this email or contact support@globproxy.com.
            </p>
          </div>`,
      }).catch(e => console.error('[reseller/reclaim] notify failed', e))
    }

    return NextResponse.json({ success: true, reclaimed_gb: reclaimed, remaining_gb: Number(row?.out_remaining_gb ?? 0) })
  } catch (err: any) {
    console.error('Reclaim error:', err)
    return NextResponse.json({ error: 'Could not reclaim this transfer.' }, { status: 500 })
  }
}
