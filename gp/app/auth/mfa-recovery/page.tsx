'use client'
import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

type State = 'unknown' | 'awaiting_confirmation' | 'waiting' | 'ready' | 'cancelled' | 'completed' | 'expired'

const card = 'w-full max-w-md bg-white border border-border rounded-2xl p-8'
const inputCls = 'w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors'
const primary = 'w-full bg-accent text-white py-3 rounded-xl font-medium text-sm hover:opacity-90 disabled:opacity-60 transition-opacity'

async function call(body: Record<string, unknown>) {
  const res = await fetch('/api/auth/mfa/recovery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

// "I lost my authenticator AND my backup codes." Three steps, deliberately
// slow (see lib/mfaRecovery.ts):
//   1. signed in + current password -> a confirmation link is e-mailed
//   2. open the link while signed in -> a 48-hour waiting period starts
//   3. after the wait -> two-factor authentication is removed
// The e-mailed link can also CANCEL the request, with no sign-in needed.
function RecoveryFlow() {
  const params = useSearchParams()
  const token = params.get('token') ?? ''
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [status, setStatus] = useState<{ state: State; ready_at: string | null } | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    createClient().auth.getSession().then(({ data: { session } }) => setSignedIn(!!session))
  }, [])

  async function refresh() {
    if (!token) return
    const r = await call({ action: 'status', token })
    setStatus(r.ok ? r.data : { state: 'unknown', ready_at: null })
  }
  useEffect(() => { refresh() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  async function run(action: 'request' | 'confirm' | 'cancel' | 'complete') {
    setBusy(true)
    const r = await call({ action, token, password })
    setBusy(false)
    if (!r.ok) {
      if (r.status === 401) { toast.error('Please sign in first.'); return }
      toast.error(r.data?.error ?? 'Something went wrong. Please try again.')
      return
    }
    if (action === 'request') { setSent(true); setPassword(''); return }
    if (action === 'complete') {
      toast.success('Two-factor authentication removed. Turn it back on in Settings when you can.')
      window.location.href = '/dashboard/settings'
      return
    }
    if (action === 'cancel') toast.success('Recovery cancelled.')
    await refresh()
  }

  const signInHref = `/auth/login?next=${encodeURIComponent(`/auth/mfa-recovery${token ? `?token=${token}` : ''}`)}`

  // ── No token: start a request ──────────────────────────────────────
  if (!token) {
    return (
      <div className={card}>
        <h1 className="font-display font-bold text-2xl text-ink mb-2">Lost your authenticator?</h1>
        {sent ? (
          <p className="text-sm text-ink2">
            We’ve e-mailed you a confirmation link. Open it within an hour to start a 48-hour waiting period. Nothing is removed until that period ends, and you can cancel from any of the e-mails.
          </p>
        ) : signedIn === false ? (
          <>
            <p className="text-sm text-muted mb-5">Sign in with your password first. You’ll be asked for your 2FA code — you can skip that screen and come back here.</p>
            <a href={signInHref} className={`${primary} block text-center`}>Sign in →</a>
          </>
        ) : (
          <>
            <p className="text-sm text-muted mb-5">
              If you’ve lost both your authenticator app and your backup codes, we can remove two-factor authentication — but only after you confirm by e-mail and a <strong>48-hour waiting period</strong>, so nobody else can do it for you. Re-enter your password to begin.
            </p>
            <form onSubmit={e => { e.preventDefault(); run('request') }} className="flex flex-col gap-3">
              <input type="password" required value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Your password" autoComplete="current-password" className={inputCls} />
              <button type="submit" disabled={busy || !password} className={primary}>{busy ? 'Sending…' : 'E-mail me a confirmation link'}</button>
            </form>
          </>
        )}
      </div>
    )
  }

  // ── With token ────────────────────────────────────────────────────
  const state = status?.state
  const readyAt = status?.ready_at ? new Date(status.ready_at) : null
  return (
    <div className={card}>
      <h1 className="font-display font-bold text-2xl text-ink mb-2">Two-factor recovery</h1>
      {status === null && <p className="text-sm text-muted">Loading…</p>}
      {state === 'unknown' && <p className="text-sm text-muted">This link isn’t valid. Start again from the sign-in screen.</p>}
      {state === 'expired' && <p className="text-sm text-muted">This link has expired. Start recovery again.</p>}
      {state === 'cancelled' && <p className="text-sm text-ink2">This recovery request was cancelled. Nothing was changed.</p>}
      {state === 'completed' && <p className="text-sm text-ink2">Two-factor authentication was already removed through this request.</p>}

      {state === 'awaiting_confirmation' && (
        signedIn === false ? (
          <>
            <p className="text-sm text-muted mb-5">Sign in to the account first so we can be sure it’s you, then come back to this link.</p>
            <a href={signInHref} className={`${primary} block text-center`}>Sign in →</a>
          </>
        ) : (
          <>
            <p className="text-sm text-muted mb-5">Start the 48-hour waiting period? Two-factor authentication stays on until it ends.</p>
            <button onClick={() => run('confirm')} disabled={busy} className={primary}>{busy ? 'Working…' : 'Start the waiting period'}</button>
          </>
        )
      )}

      {(state === 'waiting' || state === 'ready') && (
        <>
          {state === 'waiting' ? (
            <p className="text-sm text-ink2 mb-5">
              Waiting period in progress. You can remove two-factor authentication after <strong>{readyAt?.toLocaleString()}</strong>. We’ve e-mailed you so the real owner can object.
            </p>
          ) : (
            <p className="text-sm text-ink2 mb-5">The waiting period is over. You can now remove two-factor authentication.</p>
          )}
          {state === 'ready' && (
            signedIn === false
              ? <a href={signInHref} className={`${primary} block text-center mb-3`}>Sign in to finish →</a>
              : <button onClick={() => run('complete')} disabled={busy} className={`${primary} mb-3`}>{busy ? 'Working…' : 'Remove two-factor authentication'}</button>
          )}
        </>
      )}

      {(state === 'awaiting_confirmation' || state === 'waiting' || state === 'ready') && (
        <button onClick={() => run('cancel')} disabled={busy}
          className="w-full border border-red-300 text-red-600 py-3 rounded-xl font-medium text-sm hover:bg-red-50 disabled:opacity-60 transition-colors mt-2">
          This wasn’t me — cancel
        </button>
      )}
    </div>
  )
}

export default function MfaRecoveryPage() {
  return (
    <Suspense fallback={<div className={`${card} text-center text-muted text-sm`}>Loading...</div>}>
      <RecoveryFlow />
    </Suspense>
  )
}
