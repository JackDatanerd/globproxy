'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
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

  async function authHeaders() {
    const { data: { session } } = await createClient().auth.getSession()
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session?.access_token}`,
    }
  }

  async function load() {
    const headers = await authHeaders()
    const res = await fetch(`/api/dashboard/proxies/${credentialId}/sessions`, { headers })
    const data = await res.json()
    if (res.ok) setSessions(data.sessions)
  }

  useEffect(() => { load() }, [credentialId])

  async function createSession() {
    setCreating(true)
    try {
      const headers = await authHeaders()
      const res = await fetch(`/api/dashboard/proxies/${credentialId}/sessions`, {
        method: 'POST', headers,
        body: JSON.stringify({ label: `Session ${(sessions?.length ?? 0) + 1}` }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setSessions(prev => [...(prev ?? []), data.session])
      toast.success('Session created')
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setCreating(false)
    }
  }

  async function patchSession(id: string, patch: Record<string, any>, optimistic: Partial<Session>) {
    // Optimistic update so pin/collapse feel instant — reverted on failure.
    setSessions(prev => prev?.map(s => s.id === id ? { ...s, ...optimistic } : s) ?? null)
    try {
      const headers = await authHeaders()
      const res = await fetch(`/api/dashboard/sessions/${id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
    } catch (err: any) {
      toast.error(err.message)
      load() // resync on failure
    }
  }

  async function terminateSession(id: string) {
    setSessions(prev => prev?.filter(s => s.id !== id) ?? null)
    try {
      const headers = await authHeaders()
      const res = await fetch(`/api/dashboard/sessions/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ terminate: true }) })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Session terminated — note this only stops it showing here; it naturally expires on Geonode\'s side at its lifetime')
    } catch (err: any) {
      toast.error(err.message)
      load()
    }
  }

  async function deleteSession(id: string) {
    setSessions(prev => prev?.filter(s => s.id !== id) ?? null)
    try {
      const headers = await authHeaders()
      const res = await fetch(`/api/dashboard/sessions/${id}`, { method: 'DELETE', headers })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Session deleted')
    } catch (err: any) {
      toast.error(err.message)
      load()
    }
  }

  function saveLabel(id: string) {
    const label = editLabel.trim() || 'Session'
    patchSession(id, { label }, { label })
    setEditingId(null)
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
                      onKeyDown={e => { if (e.key === 'Enter') saveLabel(s.id); if (e.key === 'Escape') setEditingId(null) }}
                      onBlur={() => saveLabel(s.id)}
                      className="flex-1 bg-white/5 text-white text-xs font-mono px-2 py-1 rounded border border-white/20 focus:outline-none focus:border-accent" />
                  ) : (
                    <button onClick={() => { setEditingId(s.id); setEditLabel(s.label) }}
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
                  <button onClick={() => terminateSession(s.id)} title="Stop showing this session (it still expires naturally on Geonode's side)"
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
