import { NextResponse } from 'next/server'
import { authorizeAdmin } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { toCsv, csvResponse } from '@/lib/csv'
import { formatCycleLabel } from '@/lib/payoutCycle'
import { fetchAllRows } from '@/lib/dbPaging'

// Bulk-pay sheet. ?status=pending (default) | paid | all, optional ?method=usdt|mpesa|bank.
// Contains the SNAPSHOTTED destination from payout time — exactly what should
// be paid, even if the affiliate has since changed their method.
export async function GET(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response

    const url = new URL(req.url)
    const status = url.searchParams.get('status') ?? 'pending'
    const method = url.searchParams.get('method')
    if (!['pending', 'paid', 'all'].includes(status)) return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    if (method && !['usdt', 'mpesa', 'bank'].includes(method)) return NextResponse.json({ error: 'Invalid method' }, { status: 400 })

    // Every matching row, paged (PostgREST silently caps a plain select at
    // 1000 rows, and the old explicit limit(5000) cut off the NEWEST payouts
    // of a long history with no warning).
    const { rows: data, error } = await fetchAllRows<any>((from, to) => {
      let q = auth.supabase
        .from('affiliate_payouts')
        .select('id, cycle_start, cycle_end, amount_usd, status, payout_method, payout_wallet_address, payout_bank_details, payout_mpesa_phone, payment_reference, paid_at, created_at, referrer:referrer_id(email, full_name, is_deleted, affiliate_status)')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
      if (status !== 'all') q = q.eq('status', status)
      if (method) q = q.eq('payout_method', method)
      return q
    })
    if (error) return NextResponse.json({ error: 'Export failed' }, { status: 500 })
    const rows = data as any[]

    await logAdminAction(auth.supabase, { adminId: auth.adminId, action: 'payouts_exported', details: { status, method, rows: rows.length } })

    const csv = toCsv(rows, [
      { header: 'Payout ID', value: r => r.id },
      { header: 'Affiliate email', value: r => r.referrer?.email ?? '' },
      { header: 'Affiliate name', value: r => r.referrer?.full_name ?? '' },
      { header: 'Account state', value: r => r.referrer?.is_deleted ? 'DELETED - do not pay' : r.referrer?.affiliate_status === 'suspended' ? 'SUSPENDED - check first' : 'ok' },
      { header: 'Cycle', value: r => formatCycleLabel(r) },
      { header: 'Amount USD', value: r => Number(r.amount_usd).toFixed(2) },
      { header: 'Method', value: r => r.payout_method },
      { header: 'USDT TRC20 address', value: r => r.payout_wallet_address ?? '' },
      { header: 'M-Pesa phone', value: r => r.payout_mpesa_phone ?? '' },
      { header: 'Bank name', value: r => r.payout_bank_details?.bankName ?? '' },
      { header: 'Account name', value: r => r.payout_bank_details?.accountName ?? '' },
      { header: 'Account number', value: r => r.payout_bank_details?.accountNumber ?? '' },
      { header: 'Bank country', value: r => r.payout_bank_details?.country ?? '' },
      { header: 'SWIFT', value: r => r.payout_bank_details?.swift ?? '' },
      { header: 'Status', value: r => r.status },
      { header: 'Reference', value: r => r.payment_reference ?? '' },
      { header: 'Paid at', value: r => r.paid_at ?? '' },
    ])
    return csvResponse(csv, `globproxy-payouts-${status}${method ? '-' + method : ''}`)
  } catch (err: any) {
    console.error('[admin/payouts-csv] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
