'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import TwoFactorSettings from '@/components/dashboard/TwoFactorSettings'

// Previously the only place an admin ever touched MFA was the one-time
// mandatory /auth/mfa-setup screen on first login — Platform Settings had
// no account/security section at all, so there was no way to see status,
// regenerate backup codes, or (via a lost-authenticator recovery path)
// disable and re-enroll, short of an engineer going into the database.
// This mirrors the same two blocks app/dashboard/settings already has for
// every other role — same components, same endpoints, just placed here
// since admin has its own settings page instead of visiting /dashboard.
export default function AdminAccountSecurity() {
  const [pw, setPw] = useState({ next: '', confirm: '' })
  const [loading, setLoading] = useState(false)

  async function changePassword(e: React.FormEvent) {
    e.preventDefault()
    if (pw.next !== pw.confirm) { toast.error('Passwords do not match'); return }
    setLoading(true)
    const { error } = await createClient().auth.updateUser({ password: pw.next })
    if (error) toast.error(error.message)
    else {
      toast.success('Password updated')
      setPw({ next: '', confirm: '' })
      fetch('/api/auth/notify-password-changed', { method: 'POST' }).catch(() => {})
    }
    setLoading(false)
  }

  return (
    <>
      <div className="bg-white border border-border rounded-xl p-6 mt-5">
        <h2 className="font-display font-bold text-base text-ink mb-5">Change password</h2>
        <form onSubmit={changePassword} className="flex flex-col gap-4">
          {([['New password', 'next', 'Min. 8 characters'], ['Confirm password', 'confirm', 'Repeat new password']] as const).map(([l, k, p]) => (
            <div key={k}>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">{l}</label>
              <input type="password" placeholder={p} value={(pw as any)[k]}
                onChange={e => setPw({ ...pw, [k]: e.target.value })}
                className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
            </div>
          ))}
          <button type="submit" disabled={loading}
            className="self-start border border-border text-ink2 px-6 py-2.5 rounded-xl text-sm font-medium hover:border-ink2 hover:text-ink disabled:opacity-60 transition-all">
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>

      <TwoFactorSettings role="admin" />
    </>
  )
}
