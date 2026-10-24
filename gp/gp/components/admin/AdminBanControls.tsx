'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export function AdminBanForm() {
  const [email, setEmail] = useState('')
  const [reason, setReason] = useState('')
  const [suspendExisting, setSuspendExisting] = useState(false)
  const [loading, setLoading] = useState(false)
  const isDomain = email.trim().startsWith('@')

  async function ban(e: React.FormEvent) {
    e.preventDefault()
    const value = email.trim()
    if (!value) return
    const msg = isDomain
      ? `Ban EVERY address at ${value} from registering? Accounts that already use the domain are not touched.`
      : `Ban ${value} from registering? Aliases of the address (case, +tags, Gmail dots) are blocked too.${suspendExisting ? ' Any account already using it will also be suspended.' : ''}`
    if (!confirm(msg)) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/ban-email', { email: value, reason, suspendExisting: suspendExisting && !isDomain })
    setLoading(false)
    if (!ok) { toast.error(data.error ?? 'Could not ban that address'); return }
    const d = data as any
    const total: number = d.existing_total ?? 0
    if (d.suspend_failures?.length) {
      toast.error(`Banned, but ${d.suspend_failures.length} account(s) could not be suspended — suspend them from the Users page.`, { duration: 9000 })
      setTimeout(() => window.location.reload(), 3500)
    } else if (d.suspended > 0) {
      toast.success(`Banned and suspended ${d.suspended} existing account${d.suspended === 1 ? '' : 's'}`, { duration: 6000 })
      setTimeout(() => window.location.reload(), 2500)
    } else if (total > 0) {
      toast(`Banned. ${total} existing account${total === 1 ? '' : 's'} already use${total === 1 ? 's' : ''} this ${isDomain ? 'domain' : 'address'} — the ban does not affect ${total === 1 ? 'it' : 'them'}. Search Users for ${isDomain ? value : 'it'} to review.`, { duration: 9000 })
      setTimeout(() => window.location.reload(), 3500)
    } else {
      toast.success(isDomain ? 'Domain banned' : 'Address banned')
      window.location.reload()
    }
  }

  return (
    <form onSubmit={ban} className="bg-white border border-border rounded-xl p-5 mb-6 flex flex-wrap gap-3 items-end">
      <div className="flex-1 min-w-[220px]">
        <label className="text-[10px] font-mono text-muted uppercase tracking-widest block mb-1.5">Email address or @domain</label>
        <input value={email} onChange={e => setEmail(e.target.value)} type="text" required placeholder="abuser@example.com  or  @throwaway.example"
          className="w-full bg-white border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent" />
      </div>
      <div className="flex-1 min-w-[220px]">
        <label className="text-[10px] font-mono text-muted uppercase tracking-widest block mb-1.5">Reason (internal)</label>
        <input value={reason} onChange={e => setReason(e.target.value)} maxLength={300} placeholder="Chargeback fraud, repeat abuse…"
          className="w-full bg-white border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent" />
      </div>
      <label className={`flex items-center gap-2 text-xs text-muted ${isDomain ? 'opacity-40' : ''}`}>
        <input type="checkbox" checked={suspendExisting && !isDomain} disabled={isDomain} onChange={e => setSuspendExisting(e.target.checked)} />
        Also suspend accounts already using it
      </label>
      <button disabled={loading} className="text-xs font-mono text-red-600 border border-red-300 px-4 py-2.5 rounded-lg hover:bg-red-50 disabled:opacity-50">
        {loading ? 'Banning…' : isDomain ? 'Ban domain' : 'Ban address'}
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
