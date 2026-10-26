'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import TrustedBrowsers from '@/components/dashboard/TrustedBrowsers'
import { saveTextFile } from '@/lib/clientApi'

interface Status {
  enrolled: boolean
  confirmed: boolean
  verified: boolean
  backup_codes_remaining: number | null
}

async function authedFetch(path: string, body?: object) {
  const { data: { session } } = await createClient().auth.getSession()
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify(body ?? {}),
  })
}

export default function TwoFactorSettings({ role }: { role?: string } = {}) {
  // Administrator accounts must keep 2FA: no Disable button (the server refuses it too).
  const isAdmin = role === 'admin'
  const router = useRouter()
  const [status, setStatus] = useState<Status | null>(null)
  const [mode, setMode] = useState<'idle' | 'disable' | 'regenerate' | 'rekey'>('idle')
  // Change authenticator: step 1 proves the CURRENT factor, step 2 scans the NEW seed and proves it.
  const [rekey, setRekey] = useState<{ secret: string; qr_svg: string } | null>(null)
  const [newCode, setNewCode] = useState('')
  const [codesAck, setCodesAck] = useState(false)
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [newCodes, setNewCodes] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [pending, setPending] = useState<{ state: 'waiting' | 'ready'; ready_at: string } | null>(null)
  const [cancellingRecovery, setCancellingRecovery] = useState(false)

  async function loadStatus() {
    setLoadError('')
    try {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/auth/mfa/status', { headers: { Authorization: `Bearer ${session?.access_token}` } })
      if (res.ok) {
        const st: Status = await res.json()
        setStatus(st)
        // Someone (maybe not you) may have started removing 2FA by e-mail —
        // surface it here, where the real owner will actually look.
        if (st.confirmed && st.verified) loadPending()
        else setPending(null)
      } else {
        // Never fall back to showing "NOT ENABLED" when the lookup itself
        // failed — an enrolled account would be offered an Enable button.
        const data = await res.json().catch(() => ({}))
        setLoadError(data.error ?? 'Could not load your two-factor status right now.')
      }
    } catch {
      setLoadError('Could not load your two-factor status right now.')
    }
  }

  async function loadPending() {
    try {
      const res = await authedFetch('/api/auth/mfa/recovery', { action: 'pending' })
      if (!res.ok) return
      const data = await res.json().catch(() => ({}))
      setPending(data.pending ?? null)
    } catch { /* the banner is a bonus; never block the card on it */ }
  }

  async function cancelPending() {
    setCancellingRecovery(true)
    try {
      const res = await authedFetch('/api/auth/mfa/recovery', { action: 'cancel_mine' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error)
      setPending(null)
      toast.success('Two-factor removal cancelled. If you didn’t start it, change your password too.')
    } catch (e: any) {
      toast.error(e?.message || 'Could not cancel that right now.')
    } finally {
      setCancellingRecovery(false)
    }
  }

  useEffect(() => { loadStatus() }, [])

  async function handleDisable(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await authedFetch('/api/auth/mfa/disable', { code })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error)
      toast.success('Two-factor authentication disabled. We recommend turning it back on.')
      setMode('idle'); setCode('')
      await loadStatus()
      router.refresh()
    } catch (e: any) {
      toast.error(e.message ?? 'Could not disable.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRegenerate(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await authedFetch('/api/auth/mfa/regenerate-backup-codes', { code })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error)
      setNewCodes(data.backup_codes)
      setMode('idle'); setCode('')
      await loadStatus()
    } catch (e: any) {
      toast.error(e.message ?? 'Could not regenerate codes.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRekeyStart(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await authedFetch('/api/auth/mfa/rekey', { action: 'start', code })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error)
      setRekey({ secret: data.secret, qr_svg: data.qr_svg })
      setCode(''); setNewCode('')
    } catch (e: any) {
      toast.error(e.message ?? 'Could not start the change.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRekeyConfirm(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await authedFetch('/api/auth/mfa/rekey', { action: 'confirm', code: newCode })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error)
      toast.success('Authenticator changed. Other trusted browsers will ask for a code again.')
      cancelRekey()
      await loadStatus()
    } catch (e: any) {
      toast.error(e.message ?? 'Could not change the authenticator.')
    } finally {
      setSubmitting(false)
    }
  }

  function cancelRekey() {
    setMode('idle'); setRekey(null); setCode(''); setNewCode('')
  }

  async function copyCodes(codes: string[]) {
    try { await navigator.clipboard.writeText(codes.join('\n')); toast.success('Backup codes copied') }
    catch { toast.error('Couldn’t copy — use Download instead.') }
  }

  function downloadCodes(codes: string[]) {
    const text = `GlobProxy backup codes\nGenerated ${new Date().toISOString()}\n\n${codes.join('\n')}\n`
    saveTextFile(text, 'globproxy-backup-codes.txt')
  }

  if (!status && loadError) {
    return (
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-2">Two-factor authentication</h2>
        <p className="text-sm text-red-500 mb-3">{loadError}</p>
        <button onClick={loadStatus} className="text-xs font-mono border border-border rounded-lg px-4 py-2 hover:border-accent hover:text-accent transition-colors">Retry</button>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-2">Two-factor authentication</h2>
        <p className="text-sm text-muted">Loading…</p>
      </div>
    )
  }

  // Freshly-generated codes take over the whole card until dismissed —
  // same "you must see these before moving on" treatment as the initial
  // setup flow (app/auth/mfa-setup), since a regenerate invalidates every
  // code the user held before.
  if (newCodes) {
    return (
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-2">New backup codes</h2>
        <p className="text-sm text-muted mb-4">Your old backup codes no longer work. Save these somewhere safe.</p>
        <div className="bg-surface border border-border rounded-xl p-4 mb-4 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-sm text-ink">
          {newCodes.map(c => <div key={c}>{c}</div>)}
        </div>
        <div className="flex gap-2 mb-4">
          <button onClick={() => downloadCodes(newCodes)} className="text-xs font-mono border border-border rounded-lg px-4 py-2 hover:border-accent hover:text-accent transition-colors">Download .txt</button>
          <button onClick={() => copyCodes(newCodes)} className="text-xs font-mono border border-border rounded-lg px-4 py-2 hover:border-accent hover:text-accent transition-colors">Copy to clipboard</button>
        </div>
        <label className="flex items-start gap-2.5 mb-4 cursor-pointer">
          <input type="checkbox" checked={codesAck} onChange={e => setCodesAck(e.target.checked)} className="mt-0.5" />
          <span className="text-xs text-muted">I’ve saved these codes somewhere safe. I understand GlobProxy can’t show them to me again.</span>
        </label>
        <button disabled={!codesAck} onClick={() => { setNewCodes(null); setCodesAck(false) }}
          className="text-xs font-mono bg-accent text-white rounded-lg px-4 py-2 hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">Done</button>
      </div>
    )
  }

  return (
    <div className="bg-white border border-border rounded-xl p-6 mb-5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-display font-bold text-base text-ink">Two-factor authentication</h2>
        {status.confirmed ? (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-accent2-light text-accent2">ENABLED</span>
        ) : (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">NOT ENABLED</span>
        )}
      </div>

      {status.confirmed && pending && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-3 mb-4">
          <p className="font-medium mb-1">Two-factor removal in progress</p>
          <p className="mb-2">
            {pending.state === 'ready'
              ? 'A request to remove two-factor authentication from this account is ready to be completed.'
              : `A request to remove two-factor authentication from this account will be ready on ${new Date(pending.ready_at).toLocaleString()}.`}
            {' '}If this wasn’t you, cancel it and change your password.
          </p>
          <button onClick={cancelPending} disabled={cancellingRecovery}
            className="font-mono border border-red-300 rounded-lg px-3 py-1.5 bg-white hover:bg-red-100 transition-colors disabled:opacity-60">
            {cancellingRecovery ? 'Cancelling…' : 'Cancel removal'}
          </button>
        </div>
      )}

      {status.confirmed && status.backup_codes_remaining !== null && status.backup_codes_remaining <= 3 && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-4">
          {status.backup_codes_remaining === 0
            ? 'You have no backup codes left. Regenerate a set now so losing your authenticator can’t lock you out.'
            : `Only ${status.backup_codes_remaining} backup code${status.backup_codes_remaining === 1 ? '' : 's'} left. Regenerate a fresh set so losing your authenticator can’t lock you out.`}
        </p>
      )}

      {!status.confirmed && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-4">
          {isAdmin
            ? 'Required for administrator accounts. Turn it on to keep using the admin area.'
            : 'Recommended. Two-factor authentication means a stolen password alone can’t get into your proxies, billing or API keys.'}
        </p>
      )}

      {!status.confirmed ? (
        <>
          <p className="text-sm text-muted mb-4">Add an authenticator app as a second sign-in step, on top of your password.</p>
          <a href="/auth/mfa-setup?next=/dashboard/settings" className="inline-block bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">
            Enable two-factor authentication →
          </a>
        </>
      ) : mode === 'idle' ? (
        <>
          <p className="text-sm text-muted mb-4">
            {status.backup_codes_remaining ?? 0} backup code{status.backup_codes_remaining === 1 ? '' : 's'} remaining.
          </p>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setMode('regenerate')} className="text-xs font-mono border border-border rounded-lg px-4 py-2.5 hover:border-accent hover:text-accent transition-colors">
              Regenerate backup codes
            </button>
            <button onClick={() => setMode('rekey')} className="text-xs font-mono border border-border rounded-lg px-4 py-2.5 hover:border-accent hover:text-accent transition-colors">
              Change authenticator
            </button>
            {!isAdmin && (
              <button onClick={() => setMode('disable')} className="text-xs font-mono border border-border rounded-lg px-4 py-2.5 text-red-500 hover:border-red-300 hover:bg-red-50 transition-colors">
                Disable
              </button>
            )}
          </div>
          {isAdmin && <p className="text-xs text-muted mt-3">Two-factor authentication is required for administrator accounts, so it can’t be turned off. Moving to a new phone? Use “Change authenticator”.</p>}
          <TrustedBrowsers />
        </>
      ) : mode === 'rekey' ? (
        !rekey ? (
          <form onSubmit={handleRekeyStart} className="flex flex-col gap-3">
            <p className="text-sm text-ink2">
              Moving to a new phone or app? Confirm with your current authenticator code — or a backup code if the old phone is gone.
              Two-factor stays on the whole time; the old authenticator keeps working until you finish.
            </p>
            <input
              type="text" autoFocus required value={code}
              onChange={e => setCode(e.target.value.slice(0, 32))}
              placeholder="6-digit code or backup code"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-2.5 rounded-xl text-sm font-mono focus:outline-none focus:border-accent transition-colors"
            />
            <div className="flex gap-2">
              <button type="submit" disabled={submitting || !code.trim()} className="text-xs font-mono px-4 py-2 rounded-lg text-white bg-accent transition-opacity hover:opacity-90 disabled:opacity-60">
                {submitting ? 'Checking…' : 'Continue'}
              </button>
              <button type="button" onClick={cancelRekey} className="text-xs font-mono border border-border rounded-lg px-4 py-2 hover:text-ink transition-colors">Cancel</button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleRekeyConfirm} className="flex flex-col gap-3">
            <p className="text-sm text-ink2">Scan this with your NEW authenticator app, then enter the 6-digit code it shows.</p>
            <div className="flex justify-center">
              <div className="bg-white border border-border rounded-xl p-3" dangerouslySetInnerHTML={{ __html: rekey.qr_svg }} />
            </div>
            <details>
              <summary className="text-xs text-muted cursor-pointer hover:text-ink transition-colors">Can’t scan? Enter this code manually</summary>
              <div className="mt-2 bg-surface border border-border rounded-lg px-3 py-2 font-mono text-xs text-ink break-all select-all">{rekey.secret}</div>
            </details>
            <input
              type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={6} value={newCode}
              onChange={e => setNewCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6-digit code from the new app"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-2.5 rounded-xl text-sm font-mono tracking-widest focus:outline-none focus:border-accent transition-colors"
            />
            <p className="text-xs text-muted">Finishing signs your other trusted browsers out of 2FA trust. Your backup codes stay the same.</p>
            <div className="flex gap-2">
              <button type="submit" disabled={submitting || newCode.length !== 6} className="text-xs font-mono px-4 py-2 rounded-lg text-white bg-accent transition-opacity hover:opacity-90 disabled:opacity-60">
                {submitting ? 'Switching…' : 'Switch authenticator'}
              </button>
              <button type="button" onClick={cancelRekey} className="text-xs font-mono border border-border rounded-lg px-4 py-2 hover:text-ink transition-colors">Cancel</button>
            </div>
          </form>
        )
      ) : (
        <form onSubmit={mode === 'disable' ? handleDisable : handleRegenerate} className="flex flex-col gap-3">
          <p className="text-sm text-ink2">
            {mode === 'disable'
              ? 'Enter your current authenticator code, or one of your backup codes, to confirm disabling two-factor authentication.'
              : 'Enter your current authenticator code, or one of your backup codes, to generate a new set of backup codes.'}
          </p>
          {mode === 'regenerate' && (
            <p className="text-xs text-muted -mt-1">
              Using a backup code to confirm will consume that code, same as using it to sign in.
            </p>
          )}
          <input
            type="text" autoFocus required value={code}
            onChange={e => setCode(e.target.value.slice(0, 32))}
            placeholder="6-digit code or backup code"
            className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-2.5 rounded-xl text-sm font-mono focus:outline-none focus:border-accent transition-colors"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={submitting || !code.trim()}
              className={`text-xs font-mono px-4 py-2 rounded-lg text-white transition-opacity hover:opacity-90 disabled:opacity-60 ${mode === 'disable' ? 'bg-red-500' : 'bg-accent'}`}>
              {submitting ? 'Confirming…' : mode === 'disable' ? 'Confirm disable' : 'Confirm & regenerate'}
            </button>
            <button type="button" onClick={() => { setMode('idle'); setCode('') }} className="text-xs font-mono border border-border rounded-lg px-4 py-2 hover:text-ink transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
