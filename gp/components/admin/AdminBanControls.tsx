'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export function AdminBanForm() {
  const [email, setEmail] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)

  async function ban(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    if (!confirm(`Ban ${email.trim()} from registering? Aliases of the address (case, +tags) are blocked too.`)) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/ban-email', { email, reason })
    setLoading(false)
    if (!ok) { toast.error(data.error ?? 'Could not ban that address'); return }
    if ((data as any).existing_account_id) {
      toast('Banned. An account with this address already exists — this does not affect it. Suspend it separately if needed.', { duration: 9000 })
      setTimeout(() => window.location.reload(), 3500)
    } else {
      toast.success('Address banned')
      window.location.reload()
    }
  }

  return (
    <form onSubmit={ban} className="bg-white border border-border rounded-xl p-5 mb-6 flex flex-wrap gap-3 items-end">
      <div className="flex-1 min-w-[220px]">
        <label className="text-[10px] font-mono text-muted uppercase tracking-widest block mb-1.5">Email address</label>
        <input value={email} onChange={e => setEmail(e.target.value)} type="email" required placeholder="abuser@example.com"
          className="w-full bg-white border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent" />
      </div>
      <div className="flex-1 min-w-[220px]">
        <label className="text-[10px] font-mono text-muted uppercase tracking-widest block mb-1.5">Reason (internal)</label>
        <input value={reason} onChange={e => setReason(e.target.value)} maxLength={300} placeholder="Chargeback fraud, repeat abuse…"
          className="w-full bg-white border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent" />
      </div>
      <button disabled={loading} className="text-xs font-mono text-red-600 border border-red-300 px-4 py-2.5 rounded-lg hover:bg-red-50 disabled:opacity-50">
        {loading ? 'Banning…' : 'Ban address'}
      </button>
    </form>
  )
}

export function AdminUnbanButton({ banId, email }: { banId: string; email: string }) {
  const [loading, setLoading] = useState(false)
  async function unban() {
    if (!confirm(`Lift the ban on ${email}? They will be able to register again.`)) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/unban-email', { banId })
    if (!ok) { toast.error(data.error ?? 'Could not lift the ban'); setLoading(false); return }
    toast.success('Ban lifted')
    window.location.reload()
  }
  return (
    <button onClick={unban} disabled={loading} className="text-xs font-mono text-muted border border-border px-3 py-1.5 rounded-lg hover:text-ink hover:border-ink2 disabled:opacity-50">
      {loading ? '…' : 'Unban'}
    </button>
  )
}
