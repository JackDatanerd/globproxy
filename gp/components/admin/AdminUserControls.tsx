'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

export default function AdminUserControls({ user }: { user: any }) {
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  async function getToken() {
    const { data: { session } } = await createClient().auth.getSession()
    return session?.access_token
  }

  async function suspendAction(action: 'suspend' | 'unsuspend') {
    const label = action === 'suspend' ? 'Suspend' : 'Reinstate'
    if (!confirm(`${label} ${user.email}?`)) return
    setLoading(true)
    const token = await getToken()
    const res = await fetch('/api/admin/suspend-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ user_id: user.id, action }),
    })
    const data = await res.json()
    if (data.error) toast.error(data.error)
    else { toast.success(action === 'suspend' ? 'User suspended and notified' : 'User reinstated and notified'); window.location.reload() }
    setLoading(false); setOpen(false)
  }

  async function changeRole(role: string) {
    if (!confirm(`Change ${user.email} to ${role}?`)) return
    setLoading(true)
    const { error } = await createClient().from('profiles').update({ role }).eq('id', user.id)
    if (error) toast.error(error.message)
    else { toast.success(`Role updated to ${role}`); window.location.reload() }
    setLoading(false); setOpen(false)
  }

  async function deleteUser() {
    if (!confirm(`PERMANENTLY DELETE ${user.email}?`)) return
    if (!confirm('This cannot be undone. Orders will be preserved for accounting. Sure?')) return
    setLoading(true)
    const token = await getToken()
    const res = await fetch('/api/admin/delete-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ user_id: user.id }),
    })
    const data = await res.json()
    if (data.error) toast.error(data.error)
    else { toast.success('User deleted'); window.location.reload() }
    setLoading(false); setOpen(false)
  }

  if (user.role === 'admin') return <span className="text-xs text-muted font-mono">Protected</span>

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} disabled={loading}
        className="text-xs font-mono text-muted border border-border px-3 py-1.5 rounded-lg hover:text-ink hover:border-ink2 transition-all">
        {loading ? '...' : 'Actions ▾'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-20 bg-white border border-border rounded-xl shadow-lg py-1.5 w-44">
            {user.is_suspended
              ? <button onClick={() => suspendAction('unsuspend')} className="w-full text-left px-4 py-2.5 text-sm text-accent2 hover:bg-accent2-light transition-colors">✓ Reinstate</button>
              : <button onClick={() => suspendAction('suspend')} className="w-full text-left px-4 py-2.5 text-sm text-yellow-600 hover:bg-yellow-50 transition-colors">⊘ Suspend</button>
            }
            <div className="h-px bg-border mx-3 my-1" />
            {user.role !== 'reseller' && <button onClick={() => changeRole('reseller')} className="w-full text-left px-4 py-2.5 text-sm text-ink2 hover:bg-surface transition-colors">→ Make reseller</button>}
            {user.role !== 'user' && <button onClick={() => changeRole('user')} className="w-full text-left px-4 py-2.5 text-sm text-ink2 hover:bg-surface transition-colors">→ Make regular user</button>}
            <div className="h-px bg-border mx-3 my-1" />
            <button onClick={deleteUser} className="w-full text-left px-4 py-2.5 text-sm text-red-500 hover:bg-red-50 transition-colors">✗ Delete account</button>
          </div>
        </>
      )}
    </div>
  )
}