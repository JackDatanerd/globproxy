'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// Every action here goes through its /api/admin/* route (never straight to
// `profiles`) so the server-side effects — session ban, proxy shut-off,
// notification email, audit log — always happen.
//
// Takes only the handful of fields it needs. The users page used to pass the
// whole profile row (payout details, MFA fields, application blobs…) into
// this client component, which ships all of it to the browser in the page
// payload.
export type AdminUserControlsUser = {
  id: string
  email: string
  role: string
  is_suspended?: boolean | null
  api_access?: boolean | null
  mfa_enabled?: boolean | null
}

export default function AdminUserControls({ user }: { user: AdminUserControlsUser }) {
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  async function run(path: string, body: Record<string, unknown>, success: string, confirmMsg?: string, redirectTo?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return
    setLoading(true)
    const { ok, data } = await adminPost(path, { user_id: user.id, ...body })
    if (!ok) {
      toast.error(data.error ?? 'Action failed')
      setLoading(false)
      setOpen(false)
      return
    }
    toast.success(success)
    // Side effects worth reading before the page reloads.
    const d = data as any
    let notes = 0
    // Suspending also shuts the user's live proxies; surface partial failures.
    const failures = d.proxy_failures?.length ?? 0
    if (failures) { notes++; toast.error(`${failures} proxy credential${failures === 1 ? '' : 's'} could not be shut off or restored upstream — check /admin/credentials`, { duration: 8000 }) }
    // A reinstate does not revive credentials that were disabled one by one.
    if (d.credentials_kept_disabled) { notes++; toast(`${d.credentials_kept_disabled} credential${d.credentials_kept_disabled === 1 ? ' was' : 's were'} disabled individually and stay off — re-enable them from the credentials list if wanted.`, { duration: 8000 }) }
    if (d.payouts_voided) { notes++; toast(`${d.payouts_voided} pending affiliate payout${d.payouts_voided === 1 ? '' : 's'} voided (the account's payout details were erased).`, { duration: 8000 }) }
    if (d.warnings?.length) { notes++; toast.error(`Deleted, but some cleanup steps failed: ${d.warnings.join('; ')}`, { duration: 12000 }) }
    // Let the notes be read before the page changes.
    setTimeout(() => { if (redirectTo) window.location.href = redirectTo; else window.location.reload() }, notes ? 3500 : 600)
  }

  async function adjustBandwidth() {
    const raw = window.prompt(`Adjust bandwidth for ${user.email}.\nEnter GB — positive to CREDIT (e.g. 5), negative to DEBIT (e.g. -2):`)
    if (raw === null) return
    const gb = Number(raw.trim())
    if (!Number.isFinite(gb) || gb === 0) { toast.error('Enter a non-zero number of GB'); return }
    const reason = window.prompt(`Reason for ${gb > 0 ? 'crediting' : 'debiting'} ${Math.abs(gb)} GB (required, kept in the audit log):`)
    if (reason === null) return
    if (reason.trim().length < 3) { toast.error('A reason is required'); return }
    if (!confirm(`${gb > 0 ? 'Credit' : 'Debit'} ${Math.abs(gb)} GB ${gb > 0 ? 'to' : 'from'} ${user.email}? The customer is emailed.`)) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/adjust-bandwidth', { userId: user.id, gb, reason })
    if (!ok) { toast.error(data.error ?? 'Adjustment failed'); setLoading(false); setOpen(false); return }
    toast.success(`Balance adjusted — ${Number((data as any).available_gb ?? 0).toFixed(2)} GB now available`)
    setTimeout(() => window.location.reload(), 900)
  }

  function suspend() {
    if (!confirm(`Suspend ${user.email}? They lose dashboard access and their live proxies are shut off.`)) return
    // window.prompt returns null on Cancel; an empty string just means "no reason".
    const reason = window.prompt('Reason (optional — shown to the user in the suspension email):', '')
    if (reason === null) return
    run('/api/admin/suspend-user', { action: 'suspend', reason }, 'User suspended')
  }

  function del() {
    if (!confirm(`Permanently delete ${user.email}? This anonymises their profile, releases their proxy credentials and cannot be undone.`)) return
    const typed = window.prompt(`Type the account email to confirm deletion:\n${user.email}`)
    if (typed === null) return
    if (typed.trim().toLowerCase() !== user.email.toLowerCase()) { toast.error('Email did not match — nothing was deleted'); return }
    run('/api/admin/delete-user', {}, 'Account deleted', undefined, '/admin/users')
  }

  if (user.role === 'admin') return <span className="text-xs text-muted font-mono">Protected</span>

  const item = 'w-full text-left px-4 py-2.5 text-sm transition-colors'

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

            {user.is_suspended
              ? <button onClick={() => run('/api/admin/suspend-user', { action: 'unsuspend' }, 'User reinstated')}
                  className={`${item} text-accent2 hover:bg-accent2-light`}>✓ Reinstate user</button>
              : <button onClick={suspend} className={`${item} text-yellow-600 hover:bg-yellow-50`}>⊘ Suspend user</button>}

            <div className="h-px bg-border mx-3 my-1" />

            <button onClick={() => { setOpen(false); adjustBandwidth() }} className={`${item} text-ink2 hover:bg-surface`}>± Adjust bandwidth</button>

            <div className="h-px bg-border mx-3 my-1" />

            {user.role !== 'reseller' && (
              <button onClick={() => run('/api/admin/update-user', { action: 'make_reseller' }, 'Role changed to reseller', `Make ${user.email} a reseller?`)}
                className={`${item} text-ink2 hover:bg-surface`}>→ Make reseller</button>
            )}
            {user.role !== 'user' && (
              <button onClick={() => run('/api/admin/update-user', { action: 'make_user' }, 'Role changed to user', `Remove reseller status from ${user.email}? Their API access is switched off too.`)}
                className={`${item} text-ink2 hover:bg-surface`}>→ Make regular user</button>
            )}

            {/* API access — resellers only. Explicit grant/revoke (idempotent)
                rather than a toggle, so a double-click can't undo itself. */}
            {user.role === 'reseller' && (
              <>
                <div className="h-px bg-border mx-3 my-1" />
                {user.api_access
                  ? <button onClick={() => run('/api/admin/update-user', { action: 'revoke_api_access' }, 'API access revoked', `Revoke API access for ${user.email}? Their keys stop working immediately.`)}
                      className={`${item} text-amber-600 hover:bg-amber-50`}>⊘ Revoke API access</button>
                  : <button onClick={() => run('/api/admin/update-user', { action: 'grant_api_access' }, 'API access granted')}
                      className={`${item} text-accent hover:bg-accent-light`}>⌘ Grant API access</button>}
              </>
            )}

            {/* MFA reset — the "lost phone and every backup code" recovery
                path; only meaningful once they have MFA enabled. */}
            {user.mfa_enabled && (
              <>
                <div className="h-px bg-border mx-3 my-1" />
                <button onClick={() => run('/api/admin/mfa-reset', {}, 'Two-factor authentication reset',
                    `Reset two-factor authentication for ${user.email}? It will be switched off and they can sign in with just their password until they re-enable it. Only do this after verifying who is asking.`)}
                  className={`${item} text-ink2 hover:bg-surface`}>⟳ Reset MFA</button>
              </>
            )}

            <div className="h-px bg-border mx-3 my-1" />
            <button onClick={del} className={`${item} text-red-500 hover:bg-red-50`}>✕ Delete account</button>
          </div>
        </>
      )}
    </div>
  )
}
