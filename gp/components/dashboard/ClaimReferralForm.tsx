'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { apiJson } from '@/lib/clientApi'

// Shown only to accounts that were never referred.
export default function ClaimReferralForm() {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      await apiJson('POST', '/api/dashboard/claim-referral', { code })
      toast.success('Referral code applied')
      setTimeout(() => window.location.reload(), 600)
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err?.message || 'Could not apply that code')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={submit} className="bg-white border border-border rounded-xl p-5 mt-4">
      <div className="text-sm font-medium text-ink mb-1">Were you referred by someone?</div>
      <div className="text-xs text-muted mb-3">Add their code before your first purchase so they get credit.</div>
      <div className="flex gap-2">
        <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={32} placeholder="Referral code"
          className="flex-1 text-sm font-mono bg-surface border border-border rounded-lg px-3 py-2 focus:outline-none focus:border-accent" />
        <button disabled={loading || !code.trim()}
          className="text-xs font-mono px-4 py-2 rounded-lg bg-accent text-white disabled:opacity-50">
          {loading ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </form>
  )
}
