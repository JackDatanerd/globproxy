'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import TrustedBrowsers from '@/components/dashboard/TrustedBrowsers'

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

export default function TwoFactorSettings({ role: _role }: { role?: string } = {}) {
  const router = useRouter()
  const [status, setStatus] = useState<Status | null>(null)
  const [mode, setMode] = useState<'idle' | 'disable' | 'regenerate'>('idle')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [newCodes, setNewCodes] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState('')

  async function loadStatus() {
    setLoadError('')
    try {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/auth/mfa/status', { headers: { Authorization: `Bearer ${session?.access_token}` } })
      if (res.ok) {
        setStatus(await res.json())
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

  function downloadCodes(codes: string[]) {
    const text = `GlobProxy backup codes\nGenerated ${new Date().toISOString()}\n\n${codes.join('\n')}\n`
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'globproxy-backup-codes.txt'; a.click()
    URL.revokeObjectURL(url)
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
        <div className="flex gap-2">
          <button onClick={() => downloadCodes(newCodes)} className="text-xs font-mono border border-border rounded-lg px-4 py-2 hover:border-accent hover:text-accent transition-colors">Download .txt</button>
          <button onClick={() => setNewCodes(null)} className="text-xs font-mono bg-accent text-white rounded-lg px-4 py-2 hover:opacity-90 transition-opacity">Done</button>
        </div>
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

      {!status.confirmed && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-4">
          Recommended. Two-factor authentication means a stolen password alone can’t get into your proxies, billing or API keys.
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
            {status.backup_codes_remaining} backup code{status.backup_codes_remaining === 1 ? '' : 's'} remaining.
          </p>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setMode('regenerate')} className="text-xs font-mono border border-border rounded-lg px-4 py-2.5 hover:border-accent hover:text-accent transition-colors">
              Regenerate backup codes
            </button>
            <button onClick={() => setMode('disable')} className="text-xs font-mono border border-border rounded-lg px-4 py-2.5 text-red-500 hover:border-red-300 hover:bg-red-50 transition-colors">
              Disable
            </button>
          </div>
          <TrustedBrowsers />
        </>
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
            onChange={e => setCode(e.target.value.trim())}
            placeholder="6-digit code or backup code"
            className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-2.5 rounded-xl text-sm font-mono focus:outline-none focus:border-accent transition-colors"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={submitting || !code}
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
