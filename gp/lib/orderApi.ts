
// Import-free so it can be unit-tested with `node --test` — see tests/. The caller supplies
// the site URL and the tax summary function (lib/invoiceTax.ts orderTaxSummary).
// The public (API-key) view of an order — one shape for GET /api/v1/orders and
// GET /api/v1/orders/:id, so a reseller's billing automation sees what the customer's
// invoice says: the plan, how it was paid, the tax inside the price, the invoice link and
// every credit note. Payment-processor references are deliberately not exposed, and the
// card method is called "card" rather than naming the processor.

export const ORDER_API_COLUMNS =
  'id, gb_amount, amount_usd, payment_status, invoice_number, refunded_usd, refunded_at, created_at, paid_at, ' +
  'plan_slug, payment_method, pay_currency, pay_amount, tax_rate_pct, tax_label, auto_recharge, dispute_status'

export interface CreditNoteRow { order_id: string; credit_note_number: string | null; amount_usd: number | string; created_at: string }

const round2 = (n: number) => Math.round(n * 100) / 100

export interface OrderApiCtx { siteUrl: string; taxOf: (o: any) => { label: string; rate_pct: number; included_usd: number } | null }

export function shapeOrder(o: any, ctx: OrderApiCtx, notes: CreditNoteRow[] = [], billedTo?: unknown) {
  const method = o.payment_method === 'mpesa' ? 'mpesa' : o.payment_method ? 'card' : null
  return {
    id: o.id,
    gb_amount: Number(o.gb_amount),
    amount_usd: Number(o.amount_usd),
    status: o.payment_status,
    plan: o.plan_slug ?? null,
    payment_method: method,
    charged_currency: o.pay_currency ?? 'USD',
    charged_amount: o.pay_amount != null ? round2(Number(o.pay_amount)) : Number(o.amount_usd),
    tax: ctx.taxOf(o),
    auto_recharge: !!o.auto_recharge,
    dispute: o.dispute_status ?? null,
    invoice_number: o.invoice_number,
    // Opens for the signed-in owner of the account (the dashboard session), not for API keys.
    invoice_url: o.invoice_number ? `${ctx.siteUrl}/invoice/${o.id}` : null,
    refunded_usd: Number(o.refunded_usd ?? 0),
    refunded_at: o.refunded_at,
    credit_notes: notes.filter(n => n.order_id === o.id && n.credit_note_number)
      .map(n => ({ number: n.credit_note_number as string, amount_usd: Number(n.amount_usd), created_at: n.created_at })),
    created_at: o.created_at,
    paid_at: o.paid_at,
    ...(billedTo !== undefined ? { billed_to: billedTo } : {}),
  }
}

// The buyer block of an invoice, from the snapshot taken when it was issued.
export function shapeBilledTo(snap: any) {
  if (!snap || typeof snap !== 'object') return null
  return {
    name: snap.name ?? null, contact: snap.contact ?? null, email: snap.email ?? null,
    address: snap.address ?? null, tax_id: snap.tax_id ?? null,
  }
}
