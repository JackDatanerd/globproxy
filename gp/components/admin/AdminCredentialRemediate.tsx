'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// For an ACTIVE session whose proxy no longer exists at the provider
// (app/api/admin/credential-remediate). Re-provision rebuilds it with what is left of the
// allocation (the whitelist comes back); Refund removes it and returns the unused GB.
export default function AdminCredentialRemediate({ credentialId }: { credentialId: string }) {
  const [loading, setLoading] = useState(false)

  async function run(action: 'reprovision' | 'refund') {
    const msg = action === 'reprovision'
      ? 'Re-provision this session? It becomes pending and a new proxy is created with the GB it has left. Consumed GB stay spent.'
      : 'Refund this session? It is deleted and its unused allocation returns to the customer’s balance. Consumed GB stay spent.'
    if (!confirm(msg)) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/credential-remediate', { credentialId, action })
    if (!ok) { toast.error(data.error ?? 'Action failed'); setLoading(false); return }
    toast.success(action === 'reprovision' ? 'Re-provisioning started' : 'Session refunded')
    window.location.reload()
  }

  return (
    <div className="flex gap-1.5 mt-1">
      <button onClick={() => run('reprovision')} disabled={loading}
        className="text-[10px] font-mono px-2 py-0.5 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50">Re-provision</button>
      <button onClick={() => run('refund')} disabled={loading}
        className="text-[10px] font-mono px-2 py-0.5 rounded-lg border border-red-200 text-red-400 hover:bg-red-50 disabled:opacity-50">Refund</button>
    </div>
  )
}
