// Pure (import-free) tax rules for invoices and credit notes, so they can be unit-tested
// with `node --test` — see tests/.
//
// Prices on GlobProxy are tax-INCLUSIVE: the amount the customer pays is the price. When
// the seller is registered for VAT (or a similar tax) set INVOICE_TAX_RATE_PCT (e.g. 16)
// and optionally INVOICE_TAX_LABEL (default "VAT"); invoices then show how much of the
// total is tax. The rate in force is frozen onto each order when it is placed
// (orders.tax_rate_pct / tax_label), so a later change never rewrites an issued invoice.
// Unset or 0 = no tax line, exactly as before.

export interface TaxConfig { rate: number; label: string }

export function currentTax(env: Record<string, string | undefined> = process.env): TaxConfig | null {
  const rate = Number(String(env.INVOICE_TAX_RATE_PCT ?? '').trim())
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) return null
  const label = String(env.INVOICE_TAX_LABEL ?? '').replace(/[^\p{L}\p{N} .\-/]/gu, '').trim().slice(0, 20) || 'VAT'
  return { rate: Math.round(rate * 100) / 100, label }
}

const round2 = (n: number) => Math.round(n * 100) / 100

// The tax contained in a tax-inclusive amount.
export function taxIncluded(total: number, ratePct: number): number {
  if (!(total > 0) || !(ratePct > 0)) return 0
  return round2(total - total / (1 + ratePct / 100))
}

// What an order row says about its tax: null when none applies.
export function orderTax(o: { tax_rate_pct?: number | string | null; tax_label?: string | null }): TaxConfig | null {
  const rate = Number(o.tax_rate_pct)
  if (!Number.isFinite(rate) || rate <= 0) return null
  return { rate, label: o.tax_label?.trim() || 'VAT' }
}
