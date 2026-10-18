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

  // /api/auth/reset now sends recovery links through the PKCE code flow
  // (see app/api/auth/reset/route.ts), which /auth/callback already
  // exchanges for a real session before ever redirecting here — so in the
  // normal case sb.auth.getSession() below just finds the cookie-based
  // session already in place and this effect does nothing.
  //
  // This stays as a fallback for any link that still arrives the old,
  // implicit way (#access_token=...&refresh_token=... in the hash — e.g.
  // an email already sent before this fix went out, or any other
  // integration that generates a recovery link outside this app's own
  // /api/auth/reset). This app's Supabase client is configured for PKCE
  // (flowType: 'pkce'), which makes it explicitly refuse to auto-consume
  // an implicit-style hash — so without this, those tokens would just sit
  // in the URL unused and getSession() would come back empty. Reading them
  // manually and calling setSession() directly sidesteps that PKCE/implicit
  // mismatch entirely, since setSession() just takes the tokens at face
  // value instead of re-deriving them from a callback-type check.
  useEffect(() => {
    const hash = window.location.hash
    if (!hash || hash.length < 2) return
    const params = new URLSearchParams(hash.slice(1))
    const access_token = params.get('access_token')
    const refresh_token = params.get('refresh_token')
    if (!access_token || !refresh_token) return

    createClient().auth.setSession({ access_token, refresh_token }).then(({ error }) => {
      if (error) {
        console.error('[update-password] setSession from URL hash failed:', error.message)
        return
      }
      // Drop the tokens from the visible URL/history now that they're
      // consumed — same reasoning as the PKCE code-cleanup in auth-js
      // itself (leaving them would mean an autofill/back-button/copy-paste
      // could keep resurfacing the raw token).
      window.history.replaceState(null, '', window.location.pathname)
    })
  }, [])

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
        if (res.status === 400 && /current password/i.test(data.error ?? '')) {
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