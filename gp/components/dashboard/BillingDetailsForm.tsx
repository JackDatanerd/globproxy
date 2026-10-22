'use client'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { apiFetch, apiJson } from '@/lib/clientApi'

// Postal address + tax / VAT id printed on FUTURE invoices (invoices already
// issued keep the details they were issued with).
export default function BillingDetailsForm() {
  const [address, setAddress] = useState('')
  const [taxId, setTaxId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    apiFetch('/api/dashboard/billing/details')
      .then(d => {
        if (!cancelled) { setAddress(d.billing_address ?? ''); setTaxId(d.tax_id ?? ''); setLoaded(true) }
      })
      .catch(() => { if (!cancelled) setLoadFailed(true) })
    return () => { cancelled = true }
  }, [])

  async function save() {
    setSaving(true)
    try {
      await apiJson('PUT', '/api/dashboard/billing/details', { billing_address: address, tax_id: taxId })
      toast.success('Billing details saved — they appear on your next invoices.')
      setOpen(false)
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err?.message || 'Could not save billing details')
    }
    setSaving(false)
  }

  return (
    <div className="bg-white border border-border rounded-xl mb-8">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-6 py-4 text-left">
        <div>
          <h2 className="font-display font-bold text-base text-ink">Invoice details</h2>
          <p className="text-xs text-muted mt-0.5">Add your company address and tax / VAT ID so they appear on invoices.</p>
        </div>
        <span className="text-muted text-sm">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="px-6 pb-6 border-t border-border pt-4">
          {loadFailed ? (
            <p className="text-sm text-muted">We couldn&apos;t load your invoice details. Refresh to try again.</p>
          ) : !loaded ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <div className="grid gap-4 max-w-lg">
              <label className="block">
                <span className="text-[10px] font-mono text-muted uppercase tracking-widest">Billing address</span>
                <textarea value={address} onChange={e => setAddress(e.target.value)} rows={4} maxLength={500}
                  placeholder={'Company name\nStreet\nCity, Postal code\nCountry'}
                  className="mt-1.5 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
              </label>
              <label className="block">
                <span className="text-[10px] font-mono text-muted uppercase tracking-widest">Tax / VAT ID (optional)</span>
                <input value={taxId} onChange={e => setTaxId(e.target.value)} maxLength={64}
                  className="mt-1.5 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
              </label>
              <div>
                <button onClick={save} disabled={saving}
                  className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium disabled:opacity-60">
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <p className="text-[11px] text-muted mt-2">Invoices already issued keep the details they were issued with.</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
