'use client'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, apiJson, saveTextFile, toastApiError } from '@/lib/clientApi'
import { buildProxyUsername } from '@/lib/proxyEndpoint'
import toast from 'react-hot-toast'
import clsx from 'clsx'

interface Session {
  id: string
  session_token: string
  label: string
  pinned: boolean
  collapsed: boolean
  created_at: string
}

interface Props {
  credentialId: string
  cred: any
  host: string
  port: number
  baseUser: string
  pass: string
  onCopy: (text: string, label?: string) => void
}

// Sticky sessions used to be purely ephemeral — a fresh random session ID
// generated every page render, nothing persisted, nothing to manage. This
// component makes a session a real record: create it once, it keeps its
// session token, and you can rename/pin/collapse/terminate/delete it later.
export default function SessionManager({ credentialId, cred, host, port, baseUser, pass, onCopy }: Props) {
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [batchCount, setBatchCount] = useState(1)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  async function load() {
    try {
      const data = await apiFetch(`/api/dashboard/proxies/${credentialId}/sessions`)
      setSessions(data.sessions ?? [])
      setLoadError(null)
    } catch (err: any) {
      // A failed load used to leave `sessions` null forever — an endless
      // "Loading sessions..." with no way out.
      setLoadError(err?.message || 'Couldn\u2019t load sessions')
    }
  }

  useEffect(() => { setSessions(null); setLoadError(null); load() }, [credentialId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Next unused "Session N". Using sessions.length + 1 handed out duplicate
  // names after any deletion (create 1,2,3 → delete 2 → next was "Session 3").
  function nextDefaultLabels(count: number): string[] {
    const taken = new Set((sessions ?? []).map(s => s.label))
    let n = (sessions?.length ?? 0) + 1
    const out: string[] = []
    while (out.length < count) {
      const l = `Session ${n}`
      if (!taken.has(l)) out.push(l)
      n++
    }
    return out
  }

  async function createSession() {
    setCreating(true)
    try {
      const data = await apiJson('POST', `/api/dashboard/proxies/${credentialId}/sessions`, { labels: nextDefaultLabels(batchCount) })
      const made: Session[] = data.sessions ?? (data.session ? [data.session] : [])
      setSessions(prev => [...(prev ?? []), ...made])
      toast.success(made.length > 1 ? `${made.length} sessions created` : 'Session created')
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toastApiError(err)
    } finally {
      setCreating(false)
    }
  }

  async function patchSession(id: string, patch: Record<string, any>, optimistic: Partial<Session>) {
    // Optimistic update so pin/collapse feel instant — reverted on failure.
    setSessions(prev => prev?.map(s => s.id === id ? { ...s, ...optimistic } : s) ?? null)
    try {
      await apiJson('PATCH', `/api/dashboard/sessions/${id}`, patch)
    } catch (err: any) {
      toastApiError(err)
      load() // resync on failure
    }
  }

  async function terminateSession(id: string) {
    setSessions(prev => prev?.filter(s => s.id !== id) ?? null)
    try {
      await apiJson('PATCH', `/api/dashboard/sessions/${id}`, { terminate: true })
      toast.success('Session hidden — its IP still expires on its own when the lifetime elapses')
    } catch (err: any) {
      toastApiError(err)
      load()
    }
  }

  async function deleteSession(id: string, label: string) {
    // Every other destructive action in the dashboard confirms; this one frees a
    // fixed endpoint the customer may have wired into a running job.
    if (!window.confirm(`Delete "${label}"? Its fixed endpoint stops being listed here and any job still using it should be pointed at another session.`)) return
    setSessions(prev => prev?.filter(s => s.id !== id) ?? null)
    try {
      await apiJson('DELETE', `/api/dashboard/sessions/${id}`)
      toast.success('Session deleted')
    } catch (err: any) {
      toastApiError(err)
      load()
    }
  }

  // Enter saves and Escape cancels, but both unmount the input — and a
  // focused input being removed fires onBlur, which saved a SECOND time on
  // Enter (duplicate PATCH) and saved on Escape (cancel did nothing).
  // `finishedEdit` makes whichever handler runs first win.
  const finishedEdit = useRef(false)
  function saveLabel(id: string, original: string) {
    if (finishedEdit.current) return
    finishedEdit.current = true
    const label = editLabel.trim().slice(0, 100) || 'Session'
    setEditingId(null)
    if (label !== original) patchSession(id, { label }, { label })
  }
  function cancelEdit() {
    if (finishedEdit.current) return
    finishedEdit.current = true
    setEditingId(null)
  }

  if (loadError && sessions === null) {
    return (
      <div className="text-xs text-red-500 px-3 py-3 font-mono">
        {loadError}{' '}
        <button onClick={load} className="underline hover:opacity-70">Retry</button>
      </div>
    )
  }

  if (sessions === null) {
    return <div className="text-xs text-muted px-3 py-3 font-mono">Loading sessions...</div>
  }

  const sorted = [...sessions].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
  const allEndpoints = sorted.map(s => `${host}:${port}:${buildProxyUsername(baseUser, cred, s.session_token)}:${pass}`)
  function downloadAll() {
    const safe = String(cred.label || 'sticky-sessions').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sticky-sessions'
    saveTextFile(allEndpoints.join('\n') + '\n', `${safe}-sessions.txt`)
    toast.success(`Downloaded ${allEndpoints.length} endpoint${allEndpoints.length === 1 ? '' : 's'} — the file contains the password, keep it private.`)
  }

  return (
    <div className="bg-ink rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
          Sticky sessions {sessions.length > 0 ? `(${sessions.length})` : ''}
        </span>
        <div className="flex items-center gap-1.5">
          {sessions.length > 0 && (
            <>
              <button onClick={() => onCopy(allEndpoints.join('\n'), `${allEndpoints.length} endpoint${allEndpoints.length === 1 ? '' : 's'} copied`)}
                aria-label="Copy all session endpoints"
                className="text-[10px] font-mono text-white/60 hover:text-white border border-white/15 px-2 py-1 rounded transition-colors">
                copy all
              </button>
              <button onClick={downloadAll} aria-label="Download all session endpoints as a text file"
                className="text-[10px] font-mono text-white/60 hover:text-white border border-white/15 px-2 py-1 rounded transition-colors">
                .txt
              </button>
            </>
          )}
          <select value={batchCount} onChange={e => setBatchCount(Number(e.target.value))} disabled={creating}
            aria-label="How many sessions to create"
            className="text-[10px] font-mono bg-white/5 text-white/70 border border-white/15 rounded px-1.5 py-1 focus:outline-none focus:border-accent">
            {[1, 5, 10, 25].map(n => <option key={n} value={n} className="text-ink">{n}</option>)}
          </select>
          <button onClick={createSession} disabled={creating}
            className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2.5 py-1 rounded transition-colors disabled:opacity-50">
            {creating ? 'creating...' : batchCount > 1 ? `+ ${batchCount} new sessions` : '+ new session'}
          </button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="px-3 py-4 text-[11px] font-mono text-white/40">
          No sessions yet — create one to get a fixed sticky endpoint that keeps the same exit IP.
        </div>
      ) : (
        <div className="divide-y divide-white/10">
          {sorted.map(s => {
            const endpoint = `${host}:${port}:${buildProxyUsername(baseUser, cred, s.session_token)}:${pass}`
            return (
              <div key={s.id} className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <button onClick={() => patchSession(s.id, { pinned: !s.pinned }, { pinned: !s.pinned })}
                    title={s.pinned ? 'Unpin' : 'Pin to top'} aria-label={s.pinned ? `Unpin ${s.label}` : `Pin ${s.label} to top`} aria-pressed={!!s.pinned}
                    className={clsx('text-xs', s.pinned ? 'text-accent' : 'text-white/30 hover:text-white/60')}>
                    ★
                  </button>

                  {editingId === s.id ? (
                    <input autoFocus value={editLabel} onChange={e => setEditLabel(e.target.value)}
                      maxLength={100}
                      onKeyDown={e => { if (e.key === 'Enter') saveLabel(s.id, s.label); if (e.key === 'Escape') cancelEdit() }}
                      onBlur={() => saveLabel(s.id, s.label)}
                      className="flex-1 bg-white/5 text-white text-xs font-mono px-2 py-1 rounded border border-white/20 focus:outline-none focus:border-accent" />
                  ) : (
                    <button onClick={() => { finishedEdit.current = false; setEditingId(s.id); setEditLabel(s.label) }}
                      className="flex-1 text-left text-xs font-mono text-white/80 hover:text-white truncate">
                      {s.label}
                    </button>
                  )}

                  <button onClick={() => patchSession(s.id, { collapsed: !s.collapsed }, { collapsed: !s.collapsed })}
                    aria-label={s.collapsed ? `Show endpoint for ${s.label}` : `Hide endpoint for ${s.label}`} aria-expanded={!s.collapsed}
                    className="text-[10px] font-mono text-white/40 hover:text-white/70 px-1">
                    {s.collapsed ? '▸' : '▾'}
                  </button>
                  <button onClick={() => onCopy(endpoint, 'Endpoint copied')} aria-label={`Copy endpoint for ${s.label}`}
                    className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2 py-0.5 rounded">
                    copy
                  </button>
                  {/* Two near-identical glyph buttons that both just made the row
                      vanish; spelled out so the difference is visible. */}
                  <button onClick={() => terminateSession(s.id)} aria-label={`Remove ${s.label} from the list`}
                    title="Remove from this list. The IP itself keeps working until its lifetime elapses."
                    className="text-[10px] font-mono text-white/40 hover:text-amber-400 px-1.5">
                    remove
                  </button>
                  <button onClick={() => deleteSession(s.id, s.label)} aria-label={`Delete ${s.label}`}
                    title="Delete this session and its fixed endpoint"
                    className="text-[10px] font-mono text-white/40 hover:text-red-400 px-1.5">
                    delete
                  </button>
                </div>
                {!s.collapsed && (
                  <div className="mt-1.5 font-mono text-[11px] text-white/60 break-all leading-5 pl-5">{endpoint}</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
