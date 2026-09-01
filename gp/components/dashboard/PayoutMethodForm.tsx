'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'

type Props = {
  currentMethod: 'usdt' | 'bank' | null
  currentWalletAddress: string | null
  currentBankDetails: { bankName?: string; accountName?: string; accountNumber?: string; country?: string; swift?: string } | null
  updatedAt: string | null
}

export default function PayoutMethodForm({ currentMethod, currentWalletAddress, currentBankDetails, updatedAt }: Props) {
  const [method, setMethod] = useState<'usdt' | 'bank'>(currentMethod ?? 'usdt')
  const [walletAddress, setWalletAddress] = useState(currentWalletAddress ?? '')
  const [bankName, setBankName] = useState(currentBankDetails?.bankName ?? '')
  const [accountName, setAccountName] = useState(currentBankDetails?.accountName ?? '')
  const [accountNumber, setAccountNumber] = useState(currentBankDetails?.accountNumber ?? '')
  const [country, setCountry] = useState(currentBankDetails?.country ?? '')
  const [swift, setSwift] = useState(currentBankDetails?.swift ?? '')
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(!currentMethod)

  async function handle(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    const body = method === 'usdt'
      ? { method, walletAddress }
      : { method, bankDetails: { bankName, accountName, accountNumber, country, swift } }

    const res = await fetch('/api/dashboard/update-payout-method', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setLoading(false)
    if (!res.ok || data.error) {
      toast.error(data.error ?? 'Failed to save payout method')
      return
    }
    toast.success('Payout method saved')
    setEditing(false)
    // Reflects the new server-set updated_at without a full page reload —
    // simplest correct thing is just to reload, this isn't a hot path.
    window.location.reload()
  }

  if (!editing) {
    return (
      <div className="bg-white border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-medium text-ink">Payout method</div>
          <button onClick={() => setEditing(true)} className="text-xs font-mono text-accent hover:underline">Change</button>
        </div>
        {currentMethod === 'usdt' ? (
          <div className="text-xs text-muted font-mono mt-2">USDT (TRC20) · {currentWalletAddress}</div>
        ) : (
          <div className="text-xs text-muted font-mono mt-2">
            Bank · {currentBankDetails?.bankName} · ****{currentBankDetails?.accountNumber?.slice(-4)}
          </div>
        )}
        {updatedAt && (
          <div className="text-[10px] text-muted mt-2">
            Last changed {new Date(updatedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} —
            changes take 48 hours to clear our security hold before they're eligible for a payout.
          </div>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={handle} className="bg-white border border-border rounded-xl p-5 flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-ink mb-1">Set your payout method</div>
        <div className="text-xs text-muted">
          For security, a new or changed payout method takes 48 hours before it's eligible for a payout — this protects you if your account is ever compromised.
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => setMethod('usdt')}
          className={`text-xs font-mono px-3 py-1.5 rounded-lg border ${method === 'usdt' ? 'bg-accent2 text-white border-accent2' : 'border-border text-muted'}`}>
          USDT (TRC20)
        </button>
        <button type="button" onClick={() => setMethod('bank')}
          className={`text-xs font-mono px-3 py-1.5 rounded-lg border ${method === 'bank' ? 'bg-accent2 text-white border-accent2' : 'border-border text-muted'}`}>
          Bank transfer
        </button>
      </div>

      {method === 'usdt' ? (
        <div>
          <label className="text-[10px] font-mono text-muted uppercase tracking-wider">USDT wallet address (TRC20 / Tron network only)</label>
          <input
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            placeholder="T..."
            className="w-full mt-1 text-sm font-mono text-ink bg-surface border border-border rounded-lg px-3 py-2"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Bank name"
            className="text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2" />
          <input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Account holder name"
            className="text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2" />
          <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="Account number / IBAN"
            className="text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2" />
          <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Country"
            className="text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2" />
          <input value={swift} onChange={(e) => setSwift(e.target.value)} placeholder="SWIFT/BIC (optional)"
            className="text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2" />
        </div>
      )}

      <div className="flex gap-2">
        <button type="submit" disabled={loading}
          className="text-xs font-mono px-4 py-2 rounded-lg border border-accent2 bg-accent2 text-white hover:opacity-90 transition-all disabled:opacity-50">
          {loading ? 'Saving…' : 'Save payout method'}
        </button>
        {currentMethod && (
          <button type="button" onClick={() => setEditing(false)}
            className="text-xs font-mono px-4 py-2 rounded-lg border border-border text-muted">
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}
