'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// Per-credential kill switch (app/api/admin/credential-action). Only shown
// for credentials that are active (→ Disable) or suspended (→ Enable).
export default function AdminCredentialAction({ credentialId, status }: { credentialId: string; status: string }) {
  const [loading, setLoading] = useState(false)
  if (status !== 'active' && status !== 'suspended') return <span className="text-[10px] text-muted">—</span>
  const disabling = status === 'active'

  async function handle() {
    if (disabling && !confirm('Disable this credential? Proxy traffic through it stops (the upstream limit is capped at what it has used). Reversible with Enable.')) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/credential-action', { credentialId, action: disabling ? 'disable' : 'enable' })
    if (!ok) { toast.error(data.error ?? 'Action failed'); setLoading(false); return }
    toast.success(disabling ? 'Credential disabled' : 'Credential enabled')
    window.location.reload()
  }

  return (
    <button onClick={handle} disabled={loading}
      className={`text-[11px] font-mono px-2.5 py-1 rounded-lg border transition-all disabled:opacity-50 ${
        disabling ? 'border-red-200 text-red-400 hover:bg-red-50' : 'border-border text-ink2 hover:border-ink2'
      }`}>
      {loading ? '...' : disabling ? 'Disable' : 'Enable'}
    </button>
  )
}
