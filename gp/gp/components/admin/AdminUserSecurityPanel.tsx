'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export type PanelSession = { id: string; created_at: string | null; updated_at: string | null; user_agent: string | null; ip: string | null }
export type PanelKey = { id: string; label: string; key_prefix: string; created_at: string | null; last_used_at: string | null; last_used_ip: string | null; expires_at: string | null }

const when = (d: string | null) => d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

// Incident-response view of an account: who is signed in, which API keys are
// live, and the two buttons an admin needs when it may be taken over. The
// actions go through /api/admin/force-signout (step-up, audit log, owner email).
export default function AdminUserSecurityPanel({ userId, email, sessions, keys, sessionsError, canAct }: {
  userId: string; email: string; sessions: PanelSession[]; keys: PanelKey[]; sessionsError?: boolean; canAct: boolean
}) {
  const [loading, setLoading] = useState(false)

  async function run(revokeApiKeys: boolean) {
    const msg = revokeApiKeys
      ? `Sign ${email} out of every device AND revoke all ${keys.length} API key(s)? The owner is emailed. They keep their password and 2FA.`
      : `Sign ${email} out of every device? The owner is emailed and can sign straight back in.`
    if (!confirm(msg)) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/force-signout', { user_id: userId, revokeApiKeys })
    if (!ok) { toast.error(data.error ?? 'Action failed'); setLoading(false); return }
    const d = data as any
    toast.success(`${d.sessions_revoked} session${d.sessions_revoked === 1 ? '' : 's'} ended${revokeApiKeys ? `, ${d.api_keys_revoked} key${d.api_keys_revoked === 1 ? '' : 's'} revoked` : ''}`)
    setTimeout(() => window.location.reload(), 900)
  }

  return (
    <div className="bg-white border border-border rounded-xl overflow-hidden mt-6">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-display font-bold text-base text-ink">Sessions &amp; API keys</h2>
        {canAct && (
          <div className="flex gap-2">
            <button onClick={() => run(false)} disabled={loading}
              className="text-xs font-mono text-ink2 border border-border px-3 py-1.5 rounded-lg hover:border-ink2 disabled:opacity-50">Sign out everywhere</button>
            <button onClick={() => run(true)} disabled={loading || keys.length === 0}
              className="text-xs font-mono text-red-600 border border-red-300 px-3 py-1.5 rounded-lg hover:bg-red-50 disabled:opacity-40">Sign out + revoke keys</button>
          </div>
        )}
      </div>

      <div className="px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest border-b border-border bg-surface">Login sessions ({sessionsError ? '?' : sessions.length})</div>
      {sessionsError ? (
        <div className="px-6 py-4 text-sm text-red-600">Could not load sessions.</div>
      ) : sessions.length === 0 ? (
        <div className="px-6 py-4 text-sm text-muted">No live sessions.</div>
      ) : (
        <ul>
          {sessions.map((s, i) => (
            <li key={s.id} className={`px-6 py-2.5 flex justify-between gap-4 text-xs ${i < sessions.length - 1 ? 'border-b border-border' : ''}`}>
              <span className="text-ink truncate max-w-[60%]" title={s.user_agent ?? ''}>{s.user_agent || 'Unknown device'}</span>
              <span className="font-mono text-muted text-right">{s.ip ?? '—'} · active {when(s.updated_at ?? s.created_at)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest border-y border-border bg-surface">Live API keys ({keys.length})</div>
      {keys.length === 0 ? (
        <div className="px-6 py-4 text-sm text-muted">No live keys.</div>
      ) : (
        <ul>
          {keys.map((k, i) => (
            <li key={k.id} className={`px-6 py-2.5 flex justify-between gap-4 text-xs ${i < keys.length - 1 ? 'border-b border-border' : ''}`}>
              <span className="text-ink"><span className="font-mono">{k.key_prefix}…</span> {k.label}{k.expires_at ? <span className="text-muted"> · expires {when(k.expires_at)}</span> : null}</span>
              <span className="font-mono text-muted text-right">last used {when(k.last_used_at)}{k.last_used_ip ? ` · ${k.last_used_ip}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
