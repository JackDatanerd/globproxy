'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { apiJson } from '@/lib/clientApi'

type Props = {
  currentMethod: 'usdt' | 'bank' | 'mpesa' | null
  currentWalletAddress: string | null
  // Masked by the server (lib/maskPayout): the form never holds the real values.
  currentBankDetails: { bankName?: string; country?: string; accountLast4?: string } | null
  currentMpesaPhone: string | null
  updatedAt: string | null
  // The real hold from lib/referrals (AFFILIATE_HOLD_HOURS), passed by the server page so this copy can't drift from it.
  holdHours?: number
}

export default function PayoutMethodForm({ currentMethod, currentWalletAddress, currentBankDetails, currentMpesaPhone, updatedAt, holdHours = 48 }: Props) {
  const router = useRouter()
  const [method, setMethod] = useState<'usdt' | 'bank' | 'mpesa'>(currentMethod ?? 'usdt')
  // Sensitive fields start empty — re-enter the full value to change it.
  const [walletAddress, setWalletAddress] = useState('')
  const [mpesaPhone, setMpesaPhone] = useState('')
  const [bankName, setBankName] = useState(currentBankDetails?.bankName ?? '')
  const [accountName, setAccountName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [country, setCountry] = useState(currentBankDetails?.country ?? '')
  const [swift, setSwift] = useState('')
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(!currentMethod)

  async function handle(e: React.FormEvent) {
    e.preventDefault()
    // Pasted values routinely carry leading/trailing whitespace or a newline —
    // a wallet address with a trailing space fails validation (or worse, is
    // stored and then fails at payout time).
    const body =
      method === 'usdt' ? { method, walletAddress: walletAddress.trim() } :
      method === 'mpesa' ? { method, mpesaPhone: mpesaPhone.trim() } :
      { method, bankDetails: { bankName: bankName.trim(), accountName: accountName.trim(), accountNumber: accountNumber.trim(), country: country.trim(), swift: swift.trim() } }
    setLoading(true)
    try {
      const res = await apiJson<{ unchanged?: boolean }>('POST', '/api/dashboard/update-payout-method', body)
      toast.success(res?.unchanged ? 'No changes — your payout method is already saved this way' : 'Payout method saved — check your email for confirmation')
      setEditing(false)
      // Re-fetch the server data (new updated_at / masked values) in place,
      // and drop what was typed: the full values must not linger in state.
      setWalletAddress(''); setMpesaPhone(''); setAccountName(''); setAccountNumber(''); setSwift('')
      router.refresh()
    } catch (err: any) {
      // A network failure used to throw out of this handler and leave the
      // button on "Saving…" forever.
      if (err?.code !== 'mfa_required') toast.error(err.message ?? 'Failed to save payout method')
    } finally {
      setLoading(false)
    }
  }

  async function remove() {
    if (!window.confirm('Remove your payout method? New payouts can\'t be created until you add one (your earnings keep accruing, and payouts already scheduled keep their destination).')) return
    setLoading(true)
    try {
      await apiJson('POST', '/api/dashboard/update-payout-method', { remove: true })
      toast.success('Payout method removed')
      setEditing(true)
      router.refresh()
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err.message ?? 'Could not remove your payout method')
    } finally {
      setLoading(false)
    }
  }

  if (!editing) {
    return (
      <div className="bg-white border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-medium text-ink">Payout method</div>
          <div className="flex gap-3">
            <button onClick={() => setEditing(true)} disabled={loading} className="text-xs font-mono text-accent hover:underline">Change</button>
            <button onClick={remove} disabled={loading} className="text-xs font-mono text-red-600 hover:underline disabled:opacity-50">Remove</button>
          </div>
        </div>
        {currentMethod === 'usdt' && (
          <div className="text-xs text-muted font-mono mt-2">USDT (TRC20) · {currentWalletAddress}</div>
        )}
        {currentMethod === 'mpesa' && (
          <div className="text-xs text-muted font-mono mt-2">M-Pesa · {currentMpesaPhone}</div>
        )}
        {currentMethod === 'bank' && (
          <div className="text-xs text-muted font-mono mt-2">
            Bank · {currentBankDetails?.bankName} · ****{currentBankDetails?.accountLast4}
          </div>
        )}
        {updatedAt && (
          <div className="text-[10px] text-muted mt-2">
            Last changed {new Date(updatedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} —
            changes take {holdHours} hours to clear our security hold before they're eligible for a payout.
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
          For security, a new or changed payout method takes {holdHours} hours before it's eligible for a payout — this protects you if your account is ever compromised. We'll also email you every time this changes.
        </div>
        {currentMethod && (
          <div className="text-xs text-muted mt-1.5">Your saved details aren&apos;t shown here — enter the full details again to change them.</div>
        )}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => setMethod('usdt')} aria-pressed={method === 'usdt'}
          className={`text-xs font-mono px-3 py-1.5 rounded-lg border ${method === 'usdt' ? 'bg-accent2 text-white border-accent2' : 'border-border text-muted'}`}>
          USDT (TRC20)
        </button>
        <button type="button" onClick={() => setMethod('mpesa')} aria-pressed={method === 'mpesa'}
          className={`text-xs font-mono px-3 py-1.5 rounded-lg border ${method === 'mpesa' ? 'bg-accent2 text-white border-accent2' : 'border-border text-muted'}`}>
          M-Pesa
        </button>
        <button type="button" onClick={() => setMethod('bank')} aria-pressed={method === 'bank'}
          className={`text-xs font-mono px-3 py-1.5 rounded-lg border ${method === 'bank' ? 'bg-accent2 text-white border-accent2' : 'border-border text-muted'}`}>
          Bank transfer
        </button>
      </div>

      {method === 'usdt' && (
        <div>
          <label htmlFor="payout-wallet" className="text-[10px] font-mono text-muted uppercase tracking-wider">USDT wallet address (TRC20 / Tron network only)</label>
          <input
            id="payout-wallet"
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            placeholder="T..."
            className="w-full mt-1 text-sm font-mono text-ink bg-surface border border-border rounded-lg px-3 py-2"
          />
        </div>
      )}

      {method === 'mpesa' && (
        <div>
          <label htmlFor="payout-mpesa" className="text-[10px] font-mono text-muted uppercase tracking-wider">M-Pesa phone number (Safaricom)</label>
          <input
            id="payout-mpesa"
            value={mpesaPhone}
            onChange={(e) => setMpesaPhone(e.target.value)}
            placeholder="07XX XXX XXX"
            className="w-full mt-1 text-sm font-mono text-ink bg-surface border border-border rounded-lg px-3 py-2"
          />
        </div>
      )}

      {method === 'bank' && (
        <div className="flex flex-col gap-2">
          <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Bank name" aria-label="Bank name"
            className="text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2" />
          <input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Account holder name" aria-label="Account holder name"
            className="text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2" />
          <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="Account number / IBAN" aria-label="Account number / IBAN"
            className="text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2" />
          <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Country" aria-label="Country"
            className="text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2" />
          <input value={swift} onChange={(e) => setSwift(e.target.value)} placeholder="SWIFT/BIC (optional)" aria-label="SWIFT/BIC (optional)"
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
