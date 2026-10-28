'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

export default function UpdatePasswordPage() {
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  // Recovery links arrive through the PKCE code flow: /auth/callback exchanges
  // the code for a real cookie-based session BEFORE redirecting here, so
  // sb.auth.getSession() below simply finds it.
  //
  // This page deliberately does NOT accept access/refresh tokens from the URL
  // hash any more. It used to (for old implicit-flow links), but setSession()
  // takes whatever tokens it is handed: a crafted link carrying an ATTACKER's
  // tokens signed the visitor in as the attacker, and the "new password" they
  // then typed was set on the attacker's account (session fixation / login
  // CSRF — it also handed the attacker the victim's chosen password). Links
  // that arrive without a code now fail closed in /auth/callback.

  async function handle(e: React.FormEvent) {
    e.preventDefault()
    if (pw !== confirm) { toast.error('Passwords do not match'); return }
    setLoading(true)

    // Explicitly grab the session to ensure it's active after redirect
    const sb = createClient()
    const { data: { session } } = await sb.auth.getSession()

    if (!session) {
      toast.error('Auth session missing or expired. Please click the reset link in your email again.')
      setLoading(false)
      return
    }

    // Server-side change: enforces the password policy, revokes every other
    // session, revokes MFA "verified browser" tokens, and sends the
    // "password changed" notice — none of which a browser-side
    // updateUser() could guarantee.
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // A plain signed-in session (not one that just came from an email
        // link) has to prove the current password — that lives in Settings.
        if (data.code === 'mfa_required' && typeof data.redirect === 'string' && data.redirect.startsWith('/')) {
          window.location.assign(data.redirect)
          return
        }
        if (res.status === 400 && data.code === 'current_password_required') {
          toast.error('This page is only for reset links. To change your password while signed in, use Settings.')
        } else {
          toast.error(data.error ?? 'Could not update your password. Please try again.')
        }
        setLoading(false)
        return
      }
      toast.success('Password updated!')
      // Hard navigation: accounts with 2FA are routed on to /auth/mfa-verify
      // by middleware; everyone else lands on the dashboard.
      router.push('/dashboard')
      router.refresh()
    } catch {
      toast.error('Network error. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="bg-white border border-border rounded-2xl p-10 shadow-sm">
        <h1 className="font-display font-bold text-2xl text-ink mb-1">Set new password</h1>
        <p className="text-muted text-sm mb-8">Choose a strong password for your account.</p>
        <form onSubmit={handle} className="flex flex-col gap-5">
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">New password</label>
            <input type="password" required minLength={8} maxLength={72} autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Min. 8 characters"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Confirm password</label>
            <input type="password" required value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Repeat new password"
              className={`w-full bg-surface border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none transition-colors ${confirm && pw !== confirm ? 'border-red-300' : 'border-border focus:border-accent'}`} />
            {confirm && pw !== confirm && <p className="text-xs text-red-500 mt-1.5">Passwords do not match</p>}
          </div>
          <button type="submit" disabled={loading || (!!confirm && pw !== confirm)}
            className="w-full bg-accent text-white py-3 rounded-xl font-medium text-sm hover:opacity-90 disabled:opacity-60 transition-opacity">
            {loading ? 'Updating...' : 'Update password →'}
          </button>
        </form>
      </div>
    </div>
  )
}