'use client'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PLANS, resolveOrder, CUSTOM_MIN_GB, CUSTOM_MAX_GB } from '@/lib/plans'
import { kesFor } from '@/lib/fx'
import { confirmPayment } from '@/lib/verifyPayment'
import { formatUsd } from '@/lib/format'
import toast from 'react-hot-toast'
import { redirectToMfa } from '@/lib/clientApi'
import clsx from 'clsx'

// /dashboard/proxies/new redirects here with ?reason=no_bandwidth when the
// account has nothing left to allocate. The page ignored it, so the person
// landed on a plain shop page with no hint why they'd been sent here.
// useSearchParams needs its own Suspense boundary, hence the tiny component.
function ReasonBanner() {
  const reason = useSearchParams().get('reason')
  if (reason !== 'no_bandwidth') return null
  return (
    <div className="mb-5 bg-amber-50 border border-amber-100 text-amber-800 rounded-xl px-4 py-3 text-sm">
      You don&apos;t have any unassigned bandwidth left to create a new session. Buy some below — it never expires —
      or free up GB by deleting a session you no longer use.
    </div>
  )
}

type Choice = string // a plan slug, or 'custom'
type Method = 'card' | 'mpesa'

const formatKes = (n: number) => `KES ${n.toLocaleString('en-KE')}`

export default function BuyPage() {
  const router = useRouter()
  const [choice, setChoice] = useState<Choice>('starter')
  const [customGb, setCustomGb] = useState('25')
  const [method, setMethod] = useState<Method>('card')
  // KES per USD from /api/checkout/options; null = M-Pesa not offered right now.
  const [kesRate, setKesRate] = useState<number | null>(null)
  const [saveCard, setSaveCard] = useState(false)
  const [loading, setLoading] = useState(false)
  const [statusText, setStatusText] = useState<string | null>(null)

  const quote = resolveOrder(choice, choice === 'custom' ? Number(customGb) : undefined)
  const kesTotal = quote && kesRate ? kesFor(quote.total, kesRate) : null
  const mpesaOn = method === 'mpesa' && kesRate != null

  // "Pay now" / "Try again" on an order (Billing) links here with
  // ?plan=<slug|custom>&gb=<n>&method=<card|mpesa>.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const slug = q.get('plan')
    if (slug === 'custom') {
      const gb = q.get('gb')
      if (gb && resolveOrder('custom', Number(gb))) { setChoice('custom'); setCustomGb(gb) }
    } else if (slug && PLANS.some(p => p.slug === slug)) {
      setChoice(slug)
    }
    if (q.get('method') === 'mpesa') setMethod('mpesa')
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/checkout/options')
      .then(r => r.json())
      .then(d => { if (!cancelled && d?.mpesa?.available && Number(d.mpesa.rate) > 0) setKesRate(Number(d.mpesa.rate)) })
      .catch(() => { /* card always works; M-Pesa just stays hidden */ })
    return () => { cancelled = true }
  }, [])

  async function handleBuy() {
    if (!quote) { toast.error(`Enter a whole number of GB between ${CUSTOM_MIN_GB} and ${CUSTOM_MAX_GB}.`); return }
    if (method === 'mpesa' && !kesTotal) { toast.error('M-Pesa is unavailable right now — please pay by card.'); return }
    setLoading(true)
    setStatusText('Starting checkout...')
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({
          plan: quote.slug,
          ...(quote.custom ? { gb: quote.gb } : {}),
          method: mpesaOn ? 'mpesa' : 'card',
          ...(mpesaOn && kesTotal ? { expected_kes: kesTotal } : {}),
          ...(!mpesaOn && saveCard ? { save_card: true } : {}),
        }),
      })

      // Read as text first, not res.json() directly — a Cloudflare/WAF-level
      // block or a platform-level crash returns an HTML page, not JSON, and
      // res.json() throwing on that would land in the catch below with zero
      // detail about what actually came back. Keeping the raw text (even if
      // parsing fails) means a real repro tells us plainly what broke
      // instead of falling through to a generic message every time.
      const raw = await res.text()
      let data: any
      try {
        data = JSON.parse(raw)
      } catch {
        console.error('[checkout] non-JSON response', { status: res.status, body: raw.slice(0, 500) })
        toast.error(`Checkout failed (status ${res.status}). Please try again, and contact support if it keeps happening.`)
        setLoading(false)
        setStatusText(null)
        return
      }

      if (res.status === 403 && data?.code === 'mfa_required') {
        // Verified session expired while this page was open: go verify and come back.
        redirectToMfa(data)
        return
      }
      if (res.status === 409 && data.rate_changed && Number(data.rate) > 0) {
        // The exchange rate refreshed since the page loaded: show the new price
        // and let the customer confirm it, rather than charging an unseen amount.
        setKesRate(Number(data.rate))
        toast(`The exchange rate just updated — the price is now ${formatKes(Number(data.amount_kes))}. Review it and press pay again.`, { duration: 9000, icon: '💱' })
        setLoading(false); setStatusText(null); return
      }
      if (!data.access_code && !data.url) { toast.error(data.error || 'Something went wrong'); setLoading(false); setStatusText(null); return }

      // Primary path: open Paystack's checkout inline, in a modal, so the
      // customer never leaves the site. resumeTransaction() completes the
      // *same* transaction initialize() already created server-side (same
      // amount, reference, metadata) — it doesn't create a new one, so
      // there's no separate amount/reference logic to keep in sync here.
      if (data.access_code) {
        try {
          const { default: Paystack } = await import('@paystack/inline-js')
          const popup = new Paystack()
          setStatusText('Waiting for payment...')
          popup.resumeTransaction(data.access_code, {
            onSuccess: async (tranx) => {
              setStatusText('Confirming payment...')
              // Polls while Paystack/our credit is still settling, so a slow
              // charge isn't reported as a failure.
              // M-Pesa STK pushes can take up to a minute to settle, so wait longer.
              const result = await confirmPayment(tranx.reference || data.reference, mpesaOn ? { attempts: 20 } : {})
              if (result.success) {
                toast.success('Bandwidth credited to your account!')
                router.push('/dashboard')
                router.refresh()
              } else if (result.pending || result.delayed) {
                // Money moved (or is moving) on Paystack's side; the webhook /
                // reconcile cron will credit it independently — not lost, just
                // not confirmed on-screen yet.
                toast(result.delayed && result.error ? result.error : "Your payment is still being processed. It'll appear on your dashboard shortly — contact support if it doesn't.", { duration: 10000, icon: '⏳' })
                router.push('/dashboard')
                router.refresh()
              } else {
                toast.error(result.error || 'Payment verification failed')
              }
              setLoading(false)
              setStatusText(null)
            },
            onCancel: () => {
              setLoading(false)
              setStatusText(null)
            },
            onError: (err) => {
              toast.error(err?.message || 'Payment failed to load')
              setLoading(false)
              setStatusText(null)
            },
          })
          return
        } catch (e) {
          // Inline library failed to load (ad blocker, offline CDN, etc.)
          // — fall through to the redirect flow below instead of stranding
          // the customer with no way to pay.
          console.error('Paystack inline-js failed to load, falling back to redirect:', e)
        }
      }

      if (data.url) { window.location.href = data.url; return }
      toast.error('Could not start the Paystack checkout. Please try again.')
      setLoading(false)
      setStatusText(null)
    } catch (e: any) {
      console.error('[checkout] unexpected client-side error', e)
      toast.error(e?.message ? `Failed to start checkout: ${e.message}` : 'Failed to start checkout — check your connection and try again')
      setLoading(false)
      setStatusText(null)
    }
  }

  return (
    <div className="max-w-2xl">
      <Suspense fallback={null}><ReasonBanner /></Suspense>
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Buy Bandwidth</h1>
        <p className="text-muted text-sm mt-1">All bandwidth is non-expiring — yours until every byte is used.</p>
      </div>

      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-4">Select a plan</h2>
        <div className="grid grid-cols-2 gap-3">
          {PLANS.map(p => (
            <button key={p.name} type="button" aria-pressed={choice===p.slug} onClick={() => setChoice(p.slug)}
              className={clsx('text-left p-4 rounded-xl border-2 transition-all', choice===p.slug ? 'border-accent bg-accent-light' : 'border-border hover:border-accent/40 bg-white')}>
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-medium text-ink text-sm">{p.name}</div>
                  <div className="text-xs text-muted mt-0.5">{p.gb} GB</div>
                </div>
                <div className="text-right">
                  <div className="font-display font-bold text-lg text-ink">{formatUsd(p.total)}</div>
                  <div className="text-[11px] font-mono text-muted">{formatUsd(p.price)}/GB</div>
                </div>
              </div>
              {p.gb === 1 && <div className="mt-2 text-[10px] font-mono text-accent bg-accent-light px-2 py-0.5 rounded-full inline-block">pay-as-you-go</div>}
            </button>
          ))}
          <div
            className={clsx('col-span-2 p-4 rounded-xl border-2 transition-all', choice==='custom' ? 'border-accent bg-accent-light' : 'border-border hover:border-accent/40 bg-white')}
            onClick={() => setChoice('custom')}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-ink text-sm">Custom amount</div>
                <div className="text-xs text-muted mt-0.5">Any whole number of GB, {CUSTOM_MIN_GB}–{CUSTOM_MAX_GB}. Bigger orders get the bigger-plan rate.</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <input
                  type="number" inputMode="numeric" min={CUSTOM_MIN_GB} max={CUSTOM_MAX_GB} step={1}
                  value={customGb}
                  onFocus={() => setChoice('custom')}
                  onChange={e => { setChoice('custom'); setCustomGb(e.target.value) }}
                  aria-label="Custom GB amount"
                  className="w-20 border border-border rounded-lg px-2 py-1.5 text-sm text-ink text-right focus:outline-none focus:border-accent bg-white" />
                <span className="text-sm text-muted">GB</span>
              </div>
            </div>
            {choice === 'custom' && (() => {
              const q = resolveOrder('custom', Number(customGb))
              return q
                ? <div className="mt-2 text-xs text-ink2 font-mono">{q.gb} GB → {formatUsd(q.total)} ({formatUsd(q.total / q.gb)}/GB)</div>
                : <div className="mt-2 text-xs text-red-500">Enter a whole number between {CUSTOM_MIN_GB} and {CUSTOM_MAX_GB}.</div>
            })()}
          </div>
        </div>
      </div>

      {kesRate != null && (
        <div className="bg-white border border-border rounded-xl p-6 mb-5">
          <h2 className="font-display font-bold text-base text-ink mb-4">Payment method</h2>
          <div className="grid grid-cols-2 gap-3">
            {([['card', 'Card', 'Visa / Mastercard · charged in USD'], ['mpesa', 'M-Pesa', 'STK push to your phone · charged in KES']] as const).map(([m, label, sub]) => (
              <button key={m} onClick={() => setMethod(m)}
                className={clsx('text-left p-4 rounded-xl border-2 transition-all', method===m ? 'border-accent bg-accent-light' : 'border-border hover:border-accent/40 bg-white')}>
                <div className="font-medium text-ink text-sm">{label}</div>
                <div className="text-[11px] text-muted mt-0.5">{sub}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-4">Order summary</h2>
        {[
          ['Plan', quote ? quote.name : '—'],
          ['Bandwidth', quote ? `${quote.gb} GB` : '—'],
          ['Price per GB', quote ? formatUsd(quote.total / quote.gb) : '—'],
          ['Bandwidth expiry', 'Never'],
          ['Payment', mpesaOn ? 'M-Pesa via Paystack' : 'Card via Paystack (secure checkout)'],
          ...(mpesaOn && kesRate ? [['Exchange rate', `1 USD = ${kesRate.toFixed(2)} KES`]] : []),
        ].map(([l,v])=>(
          <div key={l} className="flex justify-between text-sm py-2 border-b border-border last:border-none">
            <span className="text-muted font-light">{l}</span>
            <span className="text-ink font-medium">{v}</span>
          </div>
        ))}
        <div className="flex justify-between items-baseline mt-4">
          <span className="font-medium text-ink">Total</span>
          <span className="text-right">
            <span className="font-display font-bold text-xl text-ink">{quote ? (mpesaOn && kesTotal ? formatKes(kesTotal) : formatUsd(quote.total)) : '—'}</span>
            {mpesaOn && quote && <span className="block text-[11px] font-mono text-muted">≈ {formatUsd(quote.total)} · invoiced in USD</span>}
          </span>
        </div>
      </div>

      <button onClick={handleBuy} disabled={loading || !quote}
        className="w-full bg-accent text-white py-4 rounded-xl font-medium text-base shadow-[0_2px_12px_rgba(0,87,255,.25)] hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(0,87,255,.35)] transition-all disabled:opacity-60 disabled:transform-none">
        {loading
          ? (statusText || 'Please wait...')
          : !quote ? 'Enter a valid amount'
          : mpesaOn && kesTotal ? `Pay ${formatKes(kesTotal)} with M-Pesa →`
          : `Pay ${formatUsd(quote.total)} by card →`}
      </button>
      {!mpesaOn && (
        <label className="flex items-start gap-2 justify-center text-xs text-ink2 mt-3 cursor-pointer">
          <input type="checkbox" checked={saveCard} onChange={e => setSaveCard(e.target.checked)} className="mt-0.5" />
          <span>Save this card for auto-recharge. Nothing extra is charged now; you choose the rule in Billing and can remove the card any time.</span>
        </label>
      )}
      {mpesaOn && (
        <p className="text-center text-xs text-muted mt-3">You&apos;ll get an M-Pesa prompt on your phone — enter your PIN to confirm. Keep this page open until it completes.</p>
      )}
      <p className="text-center text-xs text-muted mt-3 font-mono">Secured by Paystack · No subscription · GB never expires</p>
      <p className="text-center text-xs text-muted mt-2">Need more than {CUSTOM_MAX_GB} GB, or a custom arrangement? <a href="mailto:sales@globproxy.com?subject=Bandwidth%20inquiry" className="text-accent hover:underline">Contact sales</a>.</p>
    </div>
  )
}
