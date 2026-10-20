'use client'
import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { safeNextPath } from '@/lib/safeNext'
import toast from 'react-hot-toast'

// Same normalisation the server applies (lib/mfa.ts parseMfaCode) so the
// button only enables for something the server will actually accept — a
// malformed paste must never reach the server and burn an attempt.
function normalize(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}
function isValidCode(raw: string): boolean {
  const c = normalize(raw)
  return /^\d{6}$/.test(c) || /^[A-Z2-9]{8}$/.test(c)
}

function MfaVerifyFlow() {
  const router = useRouter()
  const params = useSearchParams()
  // `next` is a raw query param — validated so this page can't be used as an
  // open redirect (?next=https://evil.example) right after a successful 2FA step.
  const next = safeNextPath(params.get('next'))

  const [code, setCode] = useState('')
  const [useBackupCode, setUseBackupCode] = useState(false)
  const [remember, setRemember] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!isValidCode(code)) { toast.error('Enter the 6-digit code, or a backup code like ABCD-2345.'); return }
    setSubmitting(true)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) { router.replace('/auth/login'); return }
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ code, remember }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Incorrect code.')
      if (data.used_backup_code && typeof data.backup_codes_remaining === 'number') {
        if (data.backup_codes_remaining <= 3) {
          toast(`Only ${data.backup_codes_remaining} backup code${data.backup_codes_remaining === 1 ? '' : 's'} left — generate new ones from Settings soon.`, { icon: '⚠️', duration: 6000 })
        }
      }
      router.push(next)
      router.refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function signOut() {
    // Our own gp_mfa cookie is invisible to Supabase's signOut — revoke it too.
    await fetch('/api/auth/mfa/logout', { method: 'POST' }).catch(() => {})
    await createClient().auth.signOut({ scope: 'local' })
    router.push('/auth/login')
  }

  return (
    <div className="w-full max-w-md bg-white border border-border rounded-2xl p-10 shadow-sm">
      <h1 className="font-display font-bold text-2xl text-ink mb-1">Verify it's you</h1>
      <p className="text-muted text-sm mb-8">
        {useBackupCode ? 'Enter one of your backup codes.' : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">
            {useBackupCode ? 'Backup code' : 'Authentication code'}
          </label>
          {useBackupCode ? (
            <input
              type="text" autoComplete="off" required value={code}
              onChange={e => setCode(e.target.value.toUpperCase().slice(0, 12))}
              placeholder="XXXX-XXXX"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-lg font-mono tracking-widest text-center focus:outline-none focus:border-accent transition-colors"
            />
          ) : (
            <input
              type="text" inputMode="numeric" autoComplete="one-time-code" required
              value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-lg font-mono tracking-[0.3em] text-center focus:outline-none focus:border-accent transition-colors"
            />
          )}
        </div>
        <label className="flex items-start gap-2 text-xs text-ink2 cursor-pointer">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="mt-0.5" />
          <span>Trust this browser for 30 days <span className="text-muted">(skip this step on this device — don’t tick on a shared computer; not available for admin accounts)</span></span>
        </label>
        <button
          type="submit" disabled={submitting || !isValidCode(code)}
          className="w-full bg-accent text-white py-3 rounded-xl font-medium text-sm hover:opacity-90 disabled:opacity-60 transition-opacity"
        >
          {submitting ? 'Verifying…' : 'Verify →'}
        </button>
      </form>
      <div className="text-center mt-5">
        <button
          onClick={() => { setUseBackupCode(v => !v); setCode('') }}
          className="text-xs text-muted hover:text-accent transition-colors"
        >
          {useBackupCode ? 'Use your authenticator app instead' : "Lost your device? Use a backup code"}
        </button>
      </div>
      <div className="text-center mt-2">
        <a href="/auth/mfa-recovery" className="text-xs text-muted hover:text-accent transition-colors">
          Lost your authenticator and your backup codes?
        </a>
      </div>
      <div className="flex items-center gap-3 my-6"><div className="flex-1 h-px bg-border" /><span className="text-xs text-muted">or</span><div className="flex-1 h-px bg-border" /></div>
      <p className="text-center text-sm"><button onClick={signOut} className="text-muted hover:text-ink transition-colors">Sign out and use a different account</button></p>
    </div>
  )
}

export default function MfaVerifyPage() {
  return <Suspense fallback={<div className="w-full max-w-md bg-white border border-border rounded-2xl p-10 text-center text-muted text-sm">Loading...</div>}><MfaVerifyFlow /></Suspense>
}
