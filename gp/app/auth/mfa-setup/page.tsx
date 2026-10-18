'use client'
import { useEffect, useRef, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { safeNextPath } from '@/lib/safeNext'
import toast from 'react-hot-toast'

type Step = 'loading' | 'scan' | 'confirm' | 'backup_codes' | 'error'

function MfaSetupFlow() {
  const router = useRouter()
  const params = useSearchParams()
  // `next` is a raw query param — validated so setup can't be used as an open redirect.
  const next = safeNextPath(params.get('next'))

  const [step, setStep] = useState<Step>('loading')
  const [secret, setSecret] = useState('')
  const [qrSvg, setQrSvg] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [savedAck, setSavedAck] = useState(false)
  const [alreadyEnabled, setAlreadyEnabled] = useState(false)
  // Each enroll call issues a brand-new secret, so it must run exactly once
  // per visit (React StrictMode double-invokes effects in dev, which would
  // otherwise race two secrets and leave the DB holding the one the QR
  // code doesn't show).
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    let cancelled = false
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) { router.replace('/auth/login'); return }
      try {
        const res = await fetch('/api/auth/mfa/enroll', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Could not start MFA setup.')
        if (cancelled) return
        setSecret(data.secret)
        setQrSvg(data.qr_svg)
        setStep('scan')
      } catch (e: any) {
        if (!cancelled) {
          setAlreadyEnabled(/already enabled/i.test(e.message))
          setErrorMsg(e.message)
          setStep('error')
        }
      }
    })()
    return () => { cancelled = true }
  }, [router])

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/auth/mfa/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ code }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Incorrect code.')
      setBackupCodes(data.backup_codes)
      setStep('backup_codes')
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  function downloadBackupCodes() {
    const text = `GlobProxy backup codes\nGenerated ${new Date().toISOString()}\n\nEach code can be used once if you lose access to your authenticator app.\nKeep this somewhere safe — treat it like a password.\n\n${backupCodes.join('\n')}\n`
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'globproxy-backup-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  function copyBackupCodes() {
    navigator.clipboard.writeText(backupCodes.join('\n'))
    toast.success('Copied to clipboard')
  }

  if (step === 'loading') {
    return <div className="w-full max-w-md bg-white border border-border rounded-2xl p-10 text-center text-muted text-sm">Setting up two-factor authentication…</div>
  }

  if (step === 'error') {
    return (
      <div className="w-full max-w-md bg-white border border-border rounded-2xl p-10 text-center">
        <p className="text-sm text-red-500 mb-4">{errorMsg}</p>
        {alreadyEnabled ? (
          <button onClick={() => router.push('/dashboard/settings')} className="text-sm text-accent hover:underline">Manage two-factor authentication in Settings</button>
        ) : (
          <button onClick={() => window.location.reload()} className="text-sm text-accent hover:underline">Try again</button>
        )}
      </div>
    )
  }

  if (step === 'backup_codes') {
    return (
      <div className="w-full max-w-md bg-white border border-border rounded-2xl p-10 shadow-sm">
        <h1 className="font-display font-bold text-2xl text-ink mb-1">Save your backup codes</h1>
        <p className="text-muted text-sm mb-6">
          If you lose access to your authenticator app, these are the only way back into your account.
          Each code works once. Store them somewhere safe — a password manager, not your inbox.
        </p>
        <div className="bg-surface border border-border rounded-xl p-4 mb-4 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-sm text-ink">
          {backupCodes.map(c => <div key={c}>{c}</div>)}
        </div>
        <div className="flex gap-2 mb-6">
          <button onClick={downloadBackupCodes} className="flex-1 text-xs font-mono border border-border rounded-lg py-2 hover:border-accent hover:text-accent transition-colors">Download .txt</button>
          <button onClick={copyBackupCodes} className="flex-1 text-xs font-mono border border-border rounded-lg py-2 hover:border-accent hover:text-accent transition-colors">Copy to clipboard</button>
        </div>
        <label className="flex items-start gap-2.5 mb-5 cursor-pointer">
          <input type="checkbox" checked={savedAck} onChange={e => setSavedAck(e.target.checked)} className="mt-0.5" />
          <span className="text-xs text-muted">I've saved these codes somewhere safe. I understand GlobProxy can't show them to me again.</span>
        </label>
        <button
          disabled={!savedAck}
          onClick={() => { router.push(next); router.refresh() }}
          className="w-full bg-accent text-white py-3 rounded-xl font-medium text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          Continue →
        </button>
      </div>
    )
  }

  // step === 'scan' | 'confirm' — same screen, confirm is just scan + code input active together
  return (
    <div className="w-full max-w-md bg-white border border-border rounded-2xl p-10 shadow-sm">
      <h1 className="font-display font-bold text-2xl text-ink mb-1">Set up two-factor authentication</h1>
      <p className="text-muted text-sm mb-6">
        Adds a second step when you sign in, so a stolen password alone isn’t enough. Scan this with an authenticator app —
        {' '}Google Authenticator, Authy, 1Password, or similar.
      </p>
      <div className="flex justify-center mb-4">
        <div className="bg-white border border-border rounded-xl p-3" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      </div>
      <details className="mb-6">
        <summary className="text-xs text-muted cursor-pointer hover:text-ink transition-colors">Can't scan? Enter this code manually</summary>
        <div className="mt-2 bg-surface border border-border rounded-lg px-3 py-2 font-mono text-xs text-ink break-all select-all">{secret}</div>
      </details>
      <form onSubmit={handleConfirm} className="flex flex-col gap-4">
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">6-digit code</label>
          <input
            type="text" inputMode="numeric" autoComplete="one-time-code" required
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-lg font-mono tracking-[0.3em] text-center focus:outline-none focus:border-accent transition-colors"
          />
        </div>
        <button type="submit" disabled={submitting || code.length !== 6} className="w-full bg-accent text-white py-3 rounded-xl font-medium text-sm hover:opacity-90 disabled:opacity-60 transition-opacity">
          {submitting ? 'Verifying…' : 'Verify & enable →'}
        </button>
      </form>
    </div>
  )
}

export default function MfaSetupPage() {
  return <Suspense fallback={<div className="w-full max-w-md bg-white border border-border rounded-2xl p-10 text-center text-muted text-sm">Loading...</div>}><MfaSetupFlow /></Suspense>
}
