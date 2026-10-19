'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SECURITY_EVENT_LABELS } from '@/lib/securityEventLabels'
import toast from 'react-hot-toast'

const inputCls = 'w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors'
const labelCls = 'block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5'

// Shared by the user settings page and the admin settings page, so both get
// the same server-side flows (current-password check, 2FA step-up, session
// revocation, notices) instead of each carrying its own browser-side
// supabase.auth.updateUser() copy.

export function ChangePasswordCard({ className = 'mb-5' }: { className?: string }) {
  const router = useRouter()
  const [f, setF] = useState({ current: '', next: '', confirm: '' })
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (f.next !== f.confirm) { toast.error('Passwords do not match'); return }
    setLoading(true)
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: f.current, password: f.next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data.code === 'mfa_required') {
          toast.error('Please verify your two-factor code first.')
          router.push('/auth/mfa-verify?next=/dashboard/settings')
        } else {
          toast.error(data.error ?? 'Could not update your password.')
        }
      } else {
        toast.success('Password updated. Other devices have been signed out.')
        setF({ current: '', next: '', confirm: '' })
      }
    } catch {
      toast.error('Network error. Please try again.')
    }
    setLoading(false)
  }

  return (
    <div className={`bg-white border border-border rounded-xl p-6 ${className}`}>
      <h2 className="font-display font-bold text-base text-ink mb-1">Change password</h2>
      <p className="text-xs text-muted mb-5">Changing it signs you out everywhere else.</p>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label className={labelCls}>Current password</label>
          <input type="password" required autoComplete="current-password" value={f.current} onChange={e => setF({ ...f, current: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>New password</label>
          <input type="password" required minLength={8} maxLength={72} autoComplete="new-password" placeholder="Min. 8 characters" value={f.next} onChange={e => setF({ ...f, next: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Confirm new password</label>
          <input type="password" required autoComplete="new-password" placeholder="Repeat new password" value={f.confirm} onChange={e => setF({ ...f, confirm: e.target.value })} className={inputCls} />
        </div>
        <button type="submit" disabled={loading}
          className="self-start border border-border text-ink2 px-6 py-2.5 rounded-xl text-sm font-medium hover:border-ink2 hover:text-ink disabled:opacity-60 transition-all">
          {loading ? 'Updating...' : 'Update password'}
        </button>
      </form>
    </div>
  )
}

export function ChangeEmailCard({ currentEmail, className = 'mb-5' }: { currentEmail?: string; className?: string }) {
  const router = useRouter()
  const [f, setF] = useState({ email: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setMessage('')
    try {
      const res = await fetch('/api/auth/change-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_email: f.email, current_password: f.password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data.code === 'mfa_required') {
          toast.error('Please verify your two-factor code first.')
          router.push('/auth/mfa-verify?next=/dashboard/settings')
        } else {
          toast.error(data.error ?? 'Could not start the email change.')
        }
      } else {
        setMessage(data.message ?? 'Check both inboxes to confirm the change.')
        setF({ email: '', password: '' })
      }
    } catch {
      toast.error('Network error. Please try again.')
    }
    setLoading(false)
  }

  return (
    <div className={`bg-white border border-border rounded-xl p-6 ${className}`}>
      <h2 className="font-display font-bold text-base text-ink mb-1">Change email address</h2>
      <p className="text-xs text-muted mb-5">
        {currentEmail ? <>Currently <span className="text-ink2">{currentEmail}</span>. </> : null}
        We’ll email confirmation links to both the old and new address — the change only applies once they’re confirmed.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label className={labelCls}>New email</label>
          <input type="email" required autoComplete="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Current password</label>
          <input type="password" required autoComplete="current-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} className={inputCls} />
        </div>
        {message && <p className="text-xs text-accent2 bg-accent2-light rounded-lg px-3 py-2">{message}</p>}
        <button type="submit" disabled={loading}
          className="self-start border border-border text-ink2 px-6 py-2.5 rounded-xl text-sm font-medium hover:border-ink2 hover:text-ink disabled:opacity-60 transition-all">
          {loading ? 'Sending...' : 'Change email'}
        </button>
      </form>
    </div>
  )
}

interface SecurityEventRow {
  id: string
  event: string
  ip: string | null
  user_agent: string | null
  created_at: string
}

function shortUa(ua: string | null): string {
  if (!ua) return ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}

export function SecurityActivityCard({ className = 'mb-5' }: { className?: string }) {
  const [rows, setRows] = useState<SecurityEventRow[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  async function load() {
    // RLS ("Own security events", migration 0039) limits this to the caller's own rows.
    const { data, error } = await createClient()
      .from('security_events')
      .select('id, event, ip, user_agent, created_at')
      .order('created_at', { ascending: false })
      .limit(60)
    if (error) { setLoadFailed(true); return }
    // Routine sign-ins would otherwise push the rare, important events
    // (password / 2FA / API-key changes) off a short list: keep every
    // non-login event but only the three most recent sign-ins.
    let logins = 0
    const kept = ((data ?? []) as SecurityEventRow[]).filter(r => r.event !== 'login' || ++logins <= 3)
    setRows(kept.slice(0, 15))
  }

  useEffect(() => { load() }, [])

  async function signOutOthers() {
    if (!confirm('Sign out of every other device and browser? You will stay signed in here.')) return
    setBusy(true)
    try {
      const res = await fetch('/api/auth/signout-others', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(data.error ?? 'Could not sign out other devices.')
      else { toast.success('Signed out of all other devices.'); await load() }
    } catch {
      toast.error('Network error. Please try again.')
    }
    setBusy(false)
  }

  return (
    <div className={`bg-white border border-border rounded-xl p-6 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h2 className="font-display font-bold text-base text-ink">Recent security activity</h2>
          <p className="text-xs text-muted mt-1">Don’t recognise something? Change your password and sign out other devices.</p>
        </div>
        <button onClick={signOutOthers} disabled={busy}
          className="shrink-0 text-xs font-mono border border-border rounded-lg px-3 py-2 hover:border-accent hover:text-accent disabled:opacity-60 transition-colors">
          {busy ? 'Working…' : 'Sign out other devices'}
        </button>
      </div>
      {loadFailed ? (
        <p className="text-sm text-muted mt-3">Couldn’t load activity right now.</p>
      ) : rows === null ? (
        <p className="text-sm text-muted mt-3">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted mt-3">Nothing recorded yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {rows.map(r => (
            <li key={r.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
              <span className="text-ink2">{SECURITY_EVENT_LABELS[r.event] ?? r.event}</span>
              <span className="text-[11px] font-mono text-muted text-right">
                {[shortUa(r.user_agent), r.ip].filter(Boolean).join(' · ')}
                {' · '}{new Date(r.created_at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface DeviceRow {
  id: string
  created_at: string | null
  last_active: string | null
  user_agent: string | null
  ip: string | null
  current: boolean
}

// Every browser/device currently signed in to this account, with a per-device
// "sign out". (GoTrue keeps one row per login; /api/auth/sessions lists and
// revokes them.)
export function ActiveSessionsCard({ className = 'mb-5' }: { className?: string }) {
  const [rows, setRows] = useState<DeviceRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/auth/sessions')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error)
      setRows(data.sessions as DeviceRow[])
      setFailed(false)
    } catch { setFailed(true) }
  }
  useEffect(() => { load() }, [])

  async function signOut(d: DeviceRow) {
    if (!confirm('Sign this device out?')) return
    setBusyId(d.id)
    try {
      const res = await fetch('/api/auth/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: d.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(data.error ?? 'Could not sign that device out.')
      else { toast.success('Device signed out.'); await load() }
    } catch {
      toast.error('Network error. Please try again.')
    }
    setBusyId(null)
  }

  return (
    <div className={`bg-white border border-border rounded-xl p-6 ${className}`}>
      <h2 className="font-display font-bold text-base text-ink">Where you’re signed in</h2>
      <p className="text-xs text-muted mt-1">Sign out any device you don’t recognise.</p>
      {failed ? (
        <p className="text-sm text-muted mt-3">Couldn’t load your devices right now.</p>
      ) : rows === null ? (
        <p className="text-sm text-muted mt-3">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted mt-3">No active sessions found.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {rows.map(d => (
            <li key={d.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="text-ink2 truncate">
                  {shortUa(d.user_agent)}
                  {d.current && <span className="ml-2 text-[10px] font-mono text-accent uppercase">this device</span>}
                </div>
                <div className="text-[11px] font-mono text-muted">
                  {[d.ip, d.last_active ? `active ${new Date(d.last_active).toLocaleString()}` : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              {!d.current && (
                <button onClick={() => signOut(d)} disabled={busyId === d.id}
                  className="shrink-0 text-xs font-mono border border-border rounded-lg px-3 py-1.5 hover:border-red-300 hover:text-red-500 disabled:opacity-60 transition-colors">
                  {busyId === d.id ? '…' : 'Sign out'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
