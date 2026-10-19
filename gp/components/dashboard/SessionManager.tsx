'use client'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, apiJson } from '@/lib/clientApi'
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
  function nextDefaultLabel(): string {
    const taken = new Set((sessions ?? []).map(s => s.label))
    let n = (sessions?.length ?? 0) + 1
    while (taken.has(`Session ${n}`)) n++
    return `Session ${n}`
  }

  async function createSession() {
    setCreating(true)
    try {
      const data = await apiJson('POST', `/api/dashboard/proxies/${credentialId}/sessions`, { label: nextDefaultLabel() })
      setSessions(prev => [...(prev ?? []), data.session])
      toast.success('Session created')
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err.message)
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
      toast.error(err.message)
      load() // resync on failure
    }
  }

  async function terminateSession(id: string) {
    setSessions(prev => prev?.filter(s => s.id !== id) ?? null)
    try {
      await apiJson('PATCH', `/api/dashboard/sessions/${id}`, { terminate: true })
      toast.success('Session hidden — its IP still expires on its own when the lifetime elapses')
    } catch (err: any) {
      toast.error(err.message)
      load()
    }
  }

  async function deleteSession(id: string) {
    setSessions(prev => prev?.filter(s => s.id !== id) ?? null)
    try {
      await apiJson('DELETE', `/api/dashboard/sessions/${id}`)
      toast.success('Session deleted')
    } catch (err: any) {
      toast.error(err.message)
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

  return (
    <div className="bg-ink rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
          Sticky sessions {sessions.length > 0 ? `(${sessions.length})` : ''}
        </span>
        <button onClick={createSession} disabled={creating}
          className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2.5 py-1 rounded transition-colors disabled:opacity-50">
          {creating ? 'creating...' : '+ new session'}
        </button>
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
                    title={s.pinned ? 'Unpin' : 'Pin to top'}
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
                    className="text-[10px] font-mono text-white/40 hover:text-white/70 px-1">
                    {s.collapsed ? '▸' : '▾'}
                  </button>
                  <button onClick={() => onCopy(endpoint, 'Endpoint copied')}
                    className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2 py-0.5 rounded">
                    copy
                  </button>
                  <button onClick={() => terminateSession(s.id)} title="Stop showing this session (it still expires naturally once its lifetime elapses)"
                    className="text-[10px] font-mono text-white/40 hover:text-amber-400 px-1.5">
                    ⏻
                  </button>
                  <button onClick={() => deleteSession(s.id)} title="Delete"
                    className="text-[10px] font-mono text-white/40 hover:text-red-400 px-1.5">
                    ✕
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
