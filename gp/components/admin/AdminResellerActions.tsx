'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// All actions go through their server routes (session ban, proxy shut-off,
// email and audit log live there). 'reinstate' exists because suspending a
// reseller used to be a one-way door from this page.
export default function AdminResellerActions({ userId, action }: { userId: string; action: 'approve' | 'suspend' | 'reject' | 'reinstate' }) {
  const [loading, setLoading] = useState(false)

  async function handle() {
    let path: string
    let body: Record<string, unknown>
    let success: string

    if (action === 'approve') { path = '/api/admin/approve-reseller'; body = { userId }; success = 'Reseller approved' }
    else if (action === 'reject') {
      if (!confirm('Reject this reseller application?')) return
      const reason = window.prompt('Optional note to include in the rejection email (leave blank for none):', '')
      if (reason === null) return
      path = '/api/admin/reject-reseller'; body = { userId, reason }; success = 'Application rejected'
    } else if (action === 'suspend') {
      if (!confirm('Suspend this reseller? They lose dashboard access and their live proxies are shut off.')) return
      const reason = window.prompt('Reason (optional — shown in the suspension email):', '')
      if (reason === null) return
      path = '/api/admin/suspend-user'; body = { user_id: userId, action: 'suspend', reason }; success = 'Reseller suspended'
    } else { path = '/api/admin/suspend-user'; body = { user_id: userId, action: 'unsuspend' }; success = 'Reseller reinstated' }

    setLoading(true)
    const { ok, data } = await adminPost(path, body)
    if (!ok) { toast.error(data.error ?? 'Action failed'); setLoading(false); return }
    toast.success(success)
    const failures = (data as any).proxy_failures?.length ?? 0
    if (failures) toast.error(`${failures} proxy credential${failures === 1 ? '' : 's'} could not be updated upstream — check /admin/credentials`, { duration: 8000 })
    const kept = (data as any).credentials_kept_disabled ?? 0
    if (kept) toast(`${kept} credential${kept === 1 ? ' was' : 's were'} disabled individually and stay off — re-enable from the credentials list if wanted.`, { duration: 8000 })
    setTimeout(() => window.location.reload(), failures || kept ? 3500 : 600)
  }

  const positive = action === 'approve' || action === 'reinstate'
  return (
    <button onClick={handle} disabled={loading}
      className={`text-xs font-mono px-3 py-1.5 rounded-lg border transition-all disabled:opacity-50 ${
        positive ? 'bg-accent2 text-white border-accent2 hover:opacity-90' : 'border-red-200 text-red-400 hover:bg-red-50'
      }`}>
      {loading ? '...' : action === 'approve' ? 'Approve' : action === 'reject' ? 'Reject' : action === 'reinstate' ? 'Reinstate' : 'Suspend'}
    </button>
  )
}
