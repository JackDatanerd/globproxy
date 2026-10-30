'use client'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { apiFetch, apiJson, toastApiError } from '@/lib/clientApi'
import { shortUa } from '@/lib/userAgent'

interface Browser {
  id: string
  remembered: boolean
  created_at: string
  expires_at: string
  user_agent: string | null
  ip: string | null
  current: boolean
}

// Browsers that completed the second factor. A 12-hour "verified" session and
// a 30-day "trusted" one both show up here; each can be removed on its own.
export default function TrustedBrowsers() {
  const [rows, setRows] = useState<Browser[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function load() {
    try {
      const d = await apiFetch<{ browsers: Browser[] }>('/api/auth/mfa/browsers')
      setRows(d.browsers)
      setFailed(false)
    } catch { setFailed(true) }
  }
  useEffect(() => { load() }, [])

  async function revoke(b: Browser) {
    if (b.current && !confirm('This is the browser you are using now. You will be asked for a 2FA code again. Continue?')) return
    setBusyId(b.id)
    try {
      await apiJson('DELETE', '/api/auth/mfa/browsers', { id: b.id })
      toast.success('Browser removed.')
      await load()
    } catch (e: any) {
      toastApiError(e, 'Could not remove that browser.')
    }
    setBusyId(null)
  }

  if (failed) return <p className="text-xs text-muted mt-5">Couldn’t load your verified browsers right now.</p>
  if (rows === null) return null
  return (
    <div className="mt-6 pt-5 border-t border-border">
      <h3 className="font-display font-bold text-sm text-ink">Verified &amp; trusted browsers</h3>
      <p className="text-xs text-muted mt-1">Browsers that have passed 2FA. Remove any you don’t recognise or no longer use.</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted mt-3">None right now.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {rows.map(b => (
            <li key={b.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="text-ink2 truncate">
                  {shortUa(b.user_agent) || 'Unknown browser'}
                  {b.current && <span className="ml-2 text-[10px] font-mono text-accent uppercase">this browser</span>}
                  {b.remembered && <span className="ml-2 text-[10px] font-mono text-muted uppercase">trusted 30 days</span>}
                </div>
                <div className="text-[11px] font-mono text-muted">
                  {[b.ip, `verified ${new Date(b.created_at).toLocaleString()}`, `expires ${new Date(b.expires_at).toLocaleDateString()}`].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button onClick={() => revoke(b)} disabled={busyId === b.id}
                className="shrink-0 text-xs font-mono border border-border rounded-lg px-3 py-1.5 hover:border-red-300 hover:text-red-500 disabled:opacity-60 transition-colors">
                {busyId === b.id ? '…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
