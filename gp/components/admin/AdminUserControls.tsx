'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

export default function AdminUserControls({ user }: { user: any }) {
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  async function update(data: Record<string, any>, msg: string) {
    setLoading(true)
    const { error } = await createClient().from('profiles').update(data).eq('id', user.id)
    if (error) toast.error(error.message)
    else { toast.success(msg); window.location.reload() }
    setLoading(false); setOpen(false)
  }

  async function deleteUser() {
    if (!confirm(`PERMANENTLY DELETE ${user.email}?`)) return
    if (!confirm('This cannot be undone. All their data will be lost.')) return
    setLoading(true)
    const { data: { session } } = await createClient().auth.getSession()
    const res = await fetch('/api/admin/delete-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
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
          <div className="absolute right-0 top-8 z-20 bg-white border border-border rounded-xl shadow-lg py-1.5 w-52 overflow-hidden">

            {/* Suspend / reinstate */}
            {user.is_suspended
              ? <button onClick={() => update({ is_suspended: false, suspended_at: null, suspension_reason: null }, 'User reinstated')}
                  className="w-full text-left px-4 py-2.5 text-sm text-accent2 hover:bg-accent2-light transition-colors">
                  ✓ Reinstate user
                </button>
              : <button onClick={() => {
                  if (!confirm(`Suspend ${user.email}? They will lose dashboard access.`)) return
                  update({ is_suspended: true, suspended_at: new Date().toISOString(), suspension_reason: 'Suspended by admin' }, 'User suspended')
                }}
                  className="w-full text-left px-4 py-2.5 text-sm text-yellow-600 hover:bg-yellow-50 transition-colors">
                  ⊘ Suspend user
                </button>
            }

            <div className="h-px bg-border mx-3 my-1" />

            {/* Role changes */}
            {user.role !== 'reseller' && (
              <button onClick={() => update({ role: 'reseller', reseller_status: 'approved' }, 'Role changed to reseller')}
                className="w-full text-left px-4 py-2.5 text-sm text-ink2 hover:bg-surface transition-colors">
                → Make reseller
              </button>
            )}
            {user.role !== 'user' && (
              <button onClick={() => update({ role: 'user' }, 'Role changed to user')}
                className="w-full text-left px-4 py-2.5 text-sm text-ink2 hover:bg-surface transition-colors">
                → Make regular user
              </button>
            )}

            <div className="h-px bg-border mx-3 my-1" />

            {/* API access toggle — resellers only */}
            {user.role === 'reseller' && (
              <button onClick={() => update(
                { api_access: !user.api_access },
                user.api_access ? 'API access revoked' : 'API access granted'
              )}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${user.api_access ? 'text-amber-600 hover:bg-amber-50' : 'text-accent hover:bg-accent-light'}`}>
                {user.api_access ? '⊘ Revoke API access' : '⌘ Grant API access'}
              </button>
            )}

            <div className="h-px bg-border mx-3 my-1" />

            <button onClick={deleteUser}
              className="w-full text-left px-4 py-2.5 text-sm text-red-500 hover:bg-red-50 transition-colors">
              ✗ Delete account
            </button>
          </div>
        </>
      )}
    </div>
  )
}
