import { NextResponse } from 'next/server'
import { authorizeAdmin } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { toCsv, csvResponse } from '@/lib/csv'
import { fetchAllRows } from '@/lib/dbPaging'
import { cleanSearch } from '@/components/admin/AdminPager'

const STATUSES = ['paid', 'pending', 'failed', 'cancelled', 'refunded', 'refund', 'disputed', 'refund_requested', 'uncredited', 'unfulfilled', 'refund_in_flight'] as const
const DAY = /^\d{4}-\d{2}-\d{2}$/

// Orders / refunds export for accounting. Filters mirror the Orders page:
// ?status=paid|pending|failed|cancelled|refunded|refund (any refund)|disputed|refund_requested (open customer refund requests)|uncredited|unfulfilled,
// ?q=email-or-name, ?from=YYYY-MM-DD&to=YYYY-MM-DD (by order date, UTC, inclusive).
// Canary (internal test) orders are excluded unless ?canary=1. Contains customer
// email addresses, so — like the payout and audit exports — it needs a fresh step-up
// and is itself written to the audit log.
export async function GET(req: Request) {
  try {
    const auth = await authorizeAdmin(req, { stepUp: true })
    if (!auth.ok) return auth.response
    const { supabase, adminId } = auth

    const url = new URL(req.url)
    const status = url.searchParams.get('status') ?? ''
    if (status && !(STATUSES as readonly string[]).includes(status)) return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return NextResponse.json({ error: 'Dates must be YYYY-MM-DD' }, { status: 400 })
    const q = cleanSearch(url.searchParams.get('q') ?? undefined)
    const includeCanary = url.searchParams.get('canary') === '1'

    const { rows, error } = await fetchAllRows<any>((a, b) => {
      // The customer search is an embedded filter (no id list, no cap); 'refund_requested'
      // inner-joins the open request, exactly as the Orders page does.
      let query = supabase.from('orders')
        .select('id, created_at, paid_at, gb_amount, amount_usd, pay_amount, pay_currency, payment_method, payment_status, refunded_usd, dispute_status, dispute_resolution, invoice_number, bandwidth_credited, is_canary, paystack_reference, user:user_id' + (q ? '!inner' : '') + '(email, full_name, is_deleted)' + (status === 'refund_requested' ? ', open_request:refund_requests!inner(id)' : ''))
        .order('created_at', { ascending: true }).order('id', { ascending: true }).range(a, b)
      if (!includeCanary) query = query.eq('is_canary', false)
      if (status === 'refund') query = query.gt('refunded_usd', 0)
      else if (status === 'disputed') query = query.eq('dispute_status', 'open')
      else if (status === 'refund_requested') query = query.eq('open_request.status', 'open')
      else if (status === 'refund_in_flight') query = query.not('refund_requested_at', 'is', null)
      else if (status === 'uncredited') query = query.eq('bandwidth_credited', false).in('payment_status', ['pending', 'failed', 'cancelled']).not('paystack_reference', 'is', null)
      else if (status === 'unfulfilled') query = query.eq('payment_status', 'paid').eq('bandwidth_credited', false)
      else if (status) query = query.eq('payment_status', status)
      if (q) query = query.or(`email.ilike.%${q}%,full_name.ilike.%${q}%`, { referencedTable: 'user' })
      if (from) query = query.gte('created_at', `${from}T00:00:00Z`)
      if (to) query = query.lt('created_at', new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString())
      return query
    })
    if (error) return NextResponse.json({ error: 'Export failed' }, { status: 500 })

    await logAdminAction(supabase, { adminId, action: 'orders_exported', details: { status: status || 'all', from: from || undefined, to: to || undefined, search: q ? true : undefined, rows: rows.length } })

    const csv = toCsv(rows as any[], [
      { header: 'Order ID', value: r => r.id },
      { header: 'Created (UTC)', value: r => r.created_at ?? '' },
      { header: 'Paid at (UTC)', value: r => r.paid_at ?? '' },
      { header: 'Customer email', value: r => r.user?.is_deleted ? '[deleted]' : (r.user?.email ?? '') },
      { header: 'Customer name', value: r => r.user?.is_deleted ? '[deleted]' : (r.user?.full_name ?? '') },
      { header: 'GB', value: r => r.gb_amount ?? '' },
      { header: 'Amount USD', value: r => Number(r.amount_usd ?? 0).toFixed(2) },
      { header: 'Refunded USD', value: r => Number(r.refunded_usd ?? 0).toFixed(2) },
      { header: 'Net USD', value: r => (Number(r.amount_usd ?? 0) - Number(r.refunded_usd ?? 0)).toFixed(2) },
      { header: 'Charged amount', value: r => r.pay_amount ?? '' },
      { header: 'Charged currency', value: r => r.pay_currency ?? '' },
      { header: 'Payment method', value: r => r.payment_method ?? '' },
      { header: 'Payment status', value: r => r.payment_status ?? '' },
      { header: 'Bandwidth credited', value: r => r.bandwidth_credited ? 'yes' : 'no' },
      { header: 'Dispute', value: r => r.dispute_status ? `${r.dispute_status}${r.dispute_resolution ? ` (${r.dispute_resolution})` : ''}` : '' },
      { header: 'Invoice', value: r => r.invoice_number ?? '' },
      { header: 'Payment reference', value: r => r.paystack_reference ?? '' },
      { header: 'Canary', value: r => r.is_canary ? 'yes' : '' },
    ])
    return csvResponse(csv, `globproxy-orders${status ? '-' + status : ''}${from ? '-from-' + from : ''}${to ? '-to-' + to : ''}`)
  } catch (err) {
    console.error('[admin/orders-csv] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
