'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PLANS } from '@/lib/plans'
import toast from 'react-hot-toast'
import clsx from 'clsx'

export default function BuyPage() {
  const [plan, setPlan] = useState(PLANS[1])
  const [loading, setLoading] = useState(false)

  async function handleBuy() {
    if (plan.custom) { window.location.href='mailto:sales@globproxy.com?subject=Scale Plan Inquiry'; return }
    setLoading(true)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${session?.access_token}` },
        body: JSON.stringify({ plan: plan.slug }),
      })
      const data = await res.json()
      if (data.url) window.location.href = data.url
      else toast.error(data.error || 'Something went wrong')
    } catch { toast.error('Failed to start checkout') }
    finally { setLoading(false) }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Buy Bandwidth</h1>
        <p className="text-muted text-sm mt-1">All bandwidth is non-expiring — yours until every byte is used.</p>
      </div>

      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-4">Select a plan</h2>
        <div className="grid grid-cols-2 gap-3">
          {PLANS.map(p => (
            <button key={p.name} onClick={() => setPlan(p)}
              className={clsx('text-left p-4 rounded-xl border-2 transition-all', plan.name===p.name ? 'border-accent bg-accent-light' : 'border-border hover:border-accent/40 bg-white')}>
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-medium text-ink text-sm">{p.name}</div>
                  <div className="text-xs text-muted mt-0.5">{p.gb} GB</div>
                </div>
                <div className="text-right">
                  <div className="font-display font-bold text-lg text-ink">${p.total}</div>
                  <div className="text-[11px] font-mono text-muted">${p.price}/GB</div>
                </div>
              </div>
              {p.gb === 1 && <div className="mt-2 text-[10px] font-mono text-accent bg-accent-light px-2 py-0.5 rounded-full inline-block">pay-as-you-go</div>}
              {p.custom && <div className="mt-2 text-[10px] font-mono text-accent2 bg-accent2-light px-2 py-0.5 rounded-full inline-block">contact us</div>}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-4">Order summary</h2>
        {[['Plan',plan.name],['Bandwidth',`${plan.gb} GB`],['Price per GB',`$${plan.price.toFixed(2)}`],['Bandwidth expiry','Never'],['Payment','Paystack (Card / Mobile Money)']].map(([l,v])=>(
          <div key={l} className="flex justify-between text-sm py-2 border-b border-border last:border-none">
            <span className="text-muted font-light">{l}</span>
            <span className="text-ink font-medium">{v}</span>
          </div>
        ))}
        <div className="flex justify-between mt-4">
          <span className="font-medium text-ink">Total</span>
          <span className="font-display font-bold text-xl text-ink">${plan.total.toFixed(2)}</span>
        </div>
      </div>

      <button onClick={handleBuy} disabled={loading}
        className="w-full bg-accent text-white py-4 rounded-xl font-medium text-base shadow-[0_2px_12px_rgba(0,87,255,.25)] hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(0,87,255,.35)] transition-all disabled:opacity-60 disabled:transform-none">
        {loading ? 'Redirecting to Paystack...' : plan.custom ? 'Contact sales →' : `Pay $${plan.total.toFixed(2)} via Paystack →`}
      </button>
      <p className="text-center text-xs text-muted mt-3 font-mono">Secured by Paystack · No subscription · GB never expires</p>
    </div>
  )
}
