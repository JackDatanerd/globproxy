'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

// Previously every action here wrote straight to `profiles` from the
// browser. That worked (RLS covers it), but it meant suspending a user
// never called /api/admin/suspend-user — so it didn't kill their active
// session or send the suspension email — and role/API-access changes had
// no server route at all. Routing through the actual endpoints fixes both.
export default function AdminUserControls({ user }: { user: any }) {
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  async function callSuspend(suspending: boolean, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return
    setLoading(true)
    const { data: { session } } = await createClient().auth.getSession()
    const res = await fetch('/api/admin/suspend-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ user_id: user.id, action: suspending ? 'suspend' : 'unsuspend' }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) toast.error(data.error ?? 'Action failed')
    else { toast.success(suspending ? 'User suspended' : 'User reinstated'); window.location.reload() }
    setLoading(false); setOpen(false)
  }

  async function callUpdateUser(action: 'make_reseller' | 'make_user' | 'toggle_api_access', msg: string) {
    setLoading(true)
    const { data: { session } } = await createClient().auth.getSession()
    const res = await fetch('/api/admin/update-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ user_id: user.id, action }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) toast.error(data.error ?? 'Action failed')
    else { toast.success(msg); window.location.reload() }
    setLoading(false); setOpen(false)
  }

  // Was previously only reachable by calling the API by hand — the route
  // (app/api/admin/mfa-reset) has existed since the MFA work, nothing in
  // the admin UI ever called it. Requires the admin's own MFA to already
  // be verified for this session (requireMfaVerified on the route) same
  // as delete below — the browser doesn't need to do anything extra for
  // that, it's enforced server-side off the same bearer token.
  async function callMfaReset() {
    if (!confirm(`Reset two-factor authentication for ${user.email}? They'll be asked to set it up again next time they sign in.`)) return
    setLoading(true)
    const { data: { session } } = await createClient().auth.getSession()
    const res = await fetch('/api/admin/mfa-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ user_id: user.id }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) toast.error(data.error ?? 'Action failed')
    else { toast.success('MFA reset — they\u2019ll be prompted to set it up again'); window.location.reload() }
    setLoading(false); setOpen(false)
  }

  // Same route/logic app/api/admin/delete-user has always had — this menu
  // just never had a button wired to it. Double confirmation on purpose:
  // this is a one-way anonymisation (see that route's own comments), not
  // a soft toggle like everything else in this menu.
  async function callDelete() {
    if (!confirm(`Permanently delete ${user.email}? This anonymises their profile and cannot be undone from here.`)) return
    if (!confirm('Really sure? Type OK to confirm — there is no undo for this.')) return
    setLoading(true)
    const { data: { session } } = await createClient().auth.getSession()
    const res = await fetch('/api/admin/delete-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ user_id: user.id }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) toast.error(data.error ?? 'Action failed')
    else { toast.success('Account deleted'); window.location.reload() }
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
              ? <button onClick={() => callSuspend(false)}
                  className="w-full text-left px-4 py-2.5 text-sm text-accent2 hover:bg-accent2-light transition-colors">
                  ✓ Reinstate user
                </button>
              : <button onClick={() => callSuspend(true, `Suspend ${user.email}? They will lose dashboard access.`)}
                  className="w-full text-left px-4 py-2.5 text-sm text-yellow-600 hover:bg-yellow-50 transition-colors">
                  ⊘ Suspend user
                </button>
            }

            <div className="h-px bg-border mx-3 my-1" />

            {/* Role changes */}
            {user.role !== 'reseller' && (
              <button onClick={() => callUpdateUser('make_reseller', 'Role changed to reseller')}
                className="w-full text-left px-4 py-2.5 text-sm text-ink2 hover:bg-surface transition-colors">
                → Make reseller
              </button>
            )}
            {user.role !== 'user' && (
              <button onClick={() => callUpdateUser('make_user', 'Role changed to user')}
                className="w-full text-left px-4 py-2.5 text-sm text-ink2 hover:bg-surface transition-colors">
                → Make regular user
              </button>
            )}

            {/* API access toggle — resellers only */}
            {user.role === 'reseller' && (
              <>
                <div className="h-px bg-border mx-3 my-1" />
                <button onClick={() => callUpdateUser('toggle_api_access', user.api_access ? 'API access revoked' : 'API access granted')}
                  className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${user.api_access ? 'text-amber-600 hover:bg-amber-50' : 'text-accent hover:bg-accent-light'}`}>
                  {user.api_access ? '⊘ Revoke API access' : '⌘ Grant API access'}
                </button>
              </>
            )}

            {/* MFA reset — only meaningful once they actually have it
                enabled; this is the "lost phone and every backup code"
                recovery path, see app/api/admin/mfa-reset for the full
                reasoning on why this exists as a deliberate escape hatch
                rather than something self-service. */}
            {user.mfa_enabled && (
              <>
                <div className="h-px bg-border mx-3 my-1" />
                <button onClick={callMfaReset}
                  className="w-full text-left px-4 py-2.5 text-sm text-ink2 hover:bg-surface transition-colors">
                  ⟳ Reset MFA
                </button>
              </>
            )}

            <div className="h-px bg-border mx-3 my-1" />

            {/* Delete — separated from everything above with its own
                divider and color; every other action here is reversible
                (suspend/reinstate, role toggles), this is not. */}
            <button onClick={callDelete}
              className="w-full text-left px-4 py-2.5 text-sm text-red-500 hover:bg-red-50 transition-colors">
              ✕ Delete account
            </button>

          </div>
        </>
      )}
    </div>
  )
}
