'use client'
import { useState, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { apiFetch, apiJson, copyText, toastApiError } from '@/lib/clientApi'

const ENDPOINTS = [
  {
    method: 'GET', title: 'List sub-users (paginated)',
    path: '/api/v1/sub-users?limit=100&offset=0',
    example: `curl "https://globproxy.com/api/v1/sub-users?limit=100" \\\n  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'GET', title: 'Get one sub-user',
    path: '/api/v1/sub-users/:id',
    example: `curl https://globproxy.com/api/v1/sub-users/SUB_USER_ID \\\n  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'PATCH', title: 'Update label / targeting',
    path: '/api/v1/sub-users/:id',
    example: `curl -X PATCH https://globproxy.com/api/v1/sub-users/SUB_USER_ID \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "label": "scraper-eu", "country": "de" }'`,
  },
  {
    method: 'GET', title: 'Usage history',
    path: '/api/v1/sub-users/:id/usage/history?days=7',
    example: `curl "https://globproxy.com/api/v1/sub-users/SUB_USER_ID/usage/history?days=7" \\\n  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'GET', title: 'Purchase history',
    path: '/api/v1/orders',
    example: `curl https://globproxy.com/api/v1/orders \\\n  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'POST', title: 'Create a webhook',
    path: '/api/v1/webhooks',
    example: `curl -X POST https://globproxy.com/api/v1/webhooks \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "url": "https://example.com/hooks/globproxy", "event_types": ["session_created", "bandwidth_exhausted"] }'`,
  },
  {
    method: 'GET', title: 'Bandwidth balance',
    path: '/api/v1/account/bandwidth',
    example: `curl https://globproxy.com/api/v1/account/bandwidth \\
  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'POST', title: 'Create sub-user',
    path: '/api/v1/sub-users',
    example: `curl -X POST https://globproxy.com/api/v1/sub-users \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "label": "Client A",
    "gb_allocated": 5,
    "country": "US",
    "state": "california",
    "protocol": "http",
    "session_type": "rotating"
  }'`,
  },
  {
    method: 'GET', title: 'Get sub-user usage',
    path: '/api/v1/sub-users/:id/usage',
    example: `curl https://globproxy.com/api/v1/sub-users/SUB_USER_ID/usage \\
  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'DELETE', title: 'Delete sub-user',
    path: '/api/v1/sub-users/:id',
    example: `curl -X DELETE https://globproxy.com/api/v1/sub-users/SUB_USER_ID \\
  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'POST', title: 'Top up sub-user',
    path: '/api/v1/sub-users/:id/topup',
    example: `curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/topup \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "gb_amount": 5 }'`,
  },
  {
    method: 'PATCH', title: 'Configure auto-topup',
    path: '/api/v1/sub-users/:id/auto-topup',
    example: `curl -X PATCH https://globproxy.com/api/v1/sub-users/SUB_USER_ID/auto-topup \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "enabled": true, "threshold_gb": 1, "amount_gb": 5 }'`,
  },
  {
    method: 'GET', title: 'List whitelisted IPs',
    path: '/api/v1/sub-users/:id/whitelist',
    example: `curl https://globproxy.com/api/v1/sub-users/SUB_USER_ID/whitelist \\
  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'POST', title: 'Add whitelisted IP',
    path: '/api/v1/sub-users/:id/whitelist',
    example: `curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/whitelist \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "ip": "203.0.113.4", "description": "Office IP" }'`,
  },
  {
    method: 'POST', title: 'Pause a sub-user',
    path: '/api/v1/sub-users/:id/pause',
    example: `curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/pause \\\n  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'POST', title: 'Resume a paused sub-user',
    path: '/api/v1/sub-users/:id/resume',
    example: `curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/resume \\\n  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'POST', title: 'Release unused GB back to your balance',
    path: '/api/v1/sub-users/:id/release',
    example: `curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/release \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "gb_amount": 2 }'`,
  },
  {
    method: 'POST', title: 'Rotate a sub-user password',
    path: '/api/v1/sub-users/:id/rotate-password',
    example: `curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/rotate-password \\\n  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'GET', title: 'Plan pricing',
    path: '/api/v1/pricing',
    example: `curl https://globproxy.com/api/v1/pricing \\\n  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'GET', title: 'Supported locations',
    path: '/api/v1/locations',
    example: `curl https://globproxy.com/api/v1/locations \\\n  -H "Authorization: Bearer YOUR_KEY"`,
  },
]

type ApiKeyMeta = {
  id: string
  key_prefix: string
  label: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  scopes?: string[]
  expires_at?: string | null
  last_used_ip?: string | null
  allowed_ips?: string[]
}

// How a key's scopes read in this UI. 'allocate_only' (read + allocate, NO write) is
// the least-privilege shape for a billing bot that only moves bandwidth — the API has
// always supported it, but the form could not make one, and a key like that used to be
// labelled "read-only" here even though it can move bandwidth.
type AccessLevel = 'full' | 'read' | 'allocate' | 'allocate_only'
const scopesForLevel = (v: AccessLevel): string[] =>
  v === 'read' ? ['read'] : v === 'allocate' ? ['read', 'write', 'allocate'] : v === 'allocate_only' ? ['read', 'allocate'] : ['read', 'write']
const levelOfScopes = (scopes?: string[] | null): AccessLevel =>
  !scopes ? 'full'
    : scopes.includes('allocate') ? (scopes.includes('write') ? 'allocate' : 'allocate_only')
    : scopes.includes('write') ? 'full' : 'read'
const LEVEL_LABEL: Record<AccessLevel, string> = {
  full: 'full access', read: 'read-only', allocate: 'full access + allocate', allocate_only: 'read + allocate (no other changes)',
}

export default function ApiKeysClient({ canAllocate = false }: { canAllocate?: boolean }) {
  const [keys, setKeys] = useState<ApiKeyMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newScope, setNewScope] = useState<AccessLevel>('full')
  const [newExpiry, setNewExpiry] = useState<string>('') // '' = never
  const [newIps, setNewIps] = useState('') // comma/space separated; empty = any IP
  const [justCreated, setJustCreated] = useState<string | null>(null) // plaintext, shown once
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null) // key id being edited
  const [editLabel, setEditLabel] = useState('')
  const [editIps, setEditIps] = useState('')
  const [editScope, setEditScope] = useState<AccessLevel>('full')
  const [editExpiry, setEditExpiry] = useState<string>('keep') // 'keep' | 'none' | days
  const [rotatingId, setRotatingId] = useState<string | null>(null) // key whose rotate panel is open
  const [rotateGrace, setRotateGrace] = useState<'24' | '0'>('24')
  const [rotating, setRotating] = useState(false)
  const [justRotatedNote, setJustRotatedNote] = useState<string | null>(null)
  const [activityFor, setActivityFor] = useState<string | null>(null)
  const [activity, setActivity] = useState<any[] | null>(null)
  const activityReqRef = useRef(0) // tags each activity request so a slow earlier one can't overwrite a later one

  async function loadKeys() {
    setLoading(true)
    try {
      const data = await apiFetch('/api/dashboard/api-keys')
      setKeys(data.keys ?? [])
      setLoadError(null)
    } catch (e: any) {
      // A failed load used to render "No API keys yet." — hiding keys that exist.
      setLoadError(e?.message || 'Couldn\u2019t load your API keys')
    }
    setLoading(false)
  }

  useEffect(() => { loadKeys() }, [])

  async function createKey() {
    // The plaintext key is shown once. Minting another while the banner is up
    // replaced it, losing the first key's only copy.
    if (justCreated) {
      toast.error('Copy your new key and click \u201cDone\u201d first \u2014 it can\u2019t be shown again.')
      return
    }
    setCreating(true)
    try {
      const data = await apiJson('POST', '/api/dashboard/api-keys', {
        label: newLabel.trim() || 'Default key',
        // 'allocate' = full access + moving bandwidth between accounts (resellers;
        // the server requires an IP allowlist for it).
        scopes: scopesForLevel(newScope),
        expires_in_days: newExpiry ? Number(newExpiry) : null,
        allowed_ips: newIps.split(/[\s,]+/).filter(Boolean),
      })
      setJustCreated(data.key)
      setJustRotatedNote(null)
      setNewLabel('')
      setNewIps('')
      await loadKeys()
    } catch (err: any) {
      toastApiError(err, 'Failed to create key')
    }
    setCreating(false)
  }

  async function revokeKey(id: string) {
    if (!confirm('Revoke this key? Anything using it will stop working immediately.')) return
    try {
      await apiJson('DELETE', '/api/dashboard/api-keys', { id })
      toast.success('Key revoked')
      loadKeys()
    } catch (err: any) {
      toastApiError(err, 'Failed to revoke key')
    }
  }

  const scopeOf = (k: ApiKeyMeta): AccessLevel => levelOfScopes(k.scopes)
  const scopesFor = scopesForLevel

  function startEdit(k: ApiKeyMeta) {
    setEditing(k.id); setEditLabel(k.label); setEditIps((k.allowed_ips ?? []).join(', '))
    setEditScope(scopeOf(k)); setEditExpiry('keep'); setRotatingId(null)
  }

  // Only the fields that actually changed are sent, so a pure narrowing (fewer
  // IPs, read-only, an earlier expiry) never triggers the 2FA / password step-up.
  async function saveEdit(k: ApiKeyMeta) {
    const body: Record<string, unknown> = { id: k.id }
    const label = editLabel.trim() || 'Default key'
    if (label !== k.label) body.label = label
    const ips = editIps.split(/[\s,]+/).filter(Boolean)
    if (ips.join(',') !== (k.allowed_ips ?? []).join(',')) body.allowed_ips = ips
    if (editScope !== scopeOf(k)) body.scopes = scopesFor(editScope)
    if (editExpiry !== 'keep') body.expires_in_days = editExpiry === 'none' ? null : Number(editExpiry)
    if (Object.keys(body).length === 1) { setEditing(null); return }
    try {
      await apiJson('PATCH', '/api/dashboard/api-keys', body)
      toast.success('Key updated')
      setEditing(null)
      loadKeys()
    } catch (err: any) {
      toastApiError(err, 'Failed to update key')
    }
  }

  function openRotate(id: string) {
    if (justCreated) { toast.error('Copy your new key and click \u201cDone\u201d first.'); return }
    setRotatingId(rotatingId === id ? null : id); setRotateGrace('24'); setEditing(null)
  }

  // New key with the same settings. Either the old one keeps working for 24 hours
  // so the new secret can be deployed without an outage, or (grace 0 — the old
  // secret leaked) it is revoked on the spot.
  async function rotateKey(id: string) {
    if (justCreated) { toast.error('Copy your new key and click \u201cDone\u201d first.'); return }
    setRotating(true)
    try {
      const data = await apiJson('POST', `/api/dashboard/api-keys/${id}/rotate`, { grace_hours: Number(rotateGrace) })
      setJustCreated(data.key)
      setJustRotatedNote(data.old_key_expired ? 'The old key had already expired.' : data.old_key_valid_until ? `The old key keeps working until ${new Date(data.old_key_valid_until).toLocaleString()}.` : 'The old key was revoked.')
      setRotatingId(null)
      loadKeys()
    } catch (err: any) {
      toastApiError(err, 'Failed to rotate key')
    }
    setRotating(false)
  }

  async function revokeAll() {
    if (!confirm('Revoke ALL active keys? Every integration using them stops working immediately.')) return
    try {
      const d = await apiJson('DELETE', '/api/dashboard/api-keys', { all: true })
      toast.success(`${d.revoked ?? 0} key(s) revoked`)
      loadKeys()
    } catch (err: any) {
      toastApiError(err, 'Failed to revoke keys')
    }
  }

  async function toggleActivity(id: string) {
    const req = ++activityReqRef.current
    if (activityFor === id) { setActivityFor(null); setActivity(null); return }
    setActivityFor(id); setActivity(null)
    try {
      const d = await apiFetch(`/api/dashboard/api-keys/activity?key_id=${encodeURIComponent(id)}&limit=20`)
      if (req === activityReqRef.current) setActivity(d.activity ?? [])
    } catch (err: any) {
      if (req !== activityReqRef.current) return // a newer click owns the panel now
      toastApiError(err, 'Could not load activity')
      setActivityFor(null)
    }
  }

  async function copy(text: string, label = 'Copied') {
    if (await copyText(text)) toast.success(label)
    else toast.error('Couldn\u2019t access the clipboard — select the text and copy it manually.')
  }

  // Expired keys can't authenticate any more, so they aren't "active".
  const activeKeys = keys.filter(k => !k.revoked_at && !(k.expires_at && new Date(k.expires_at).getTime() <= Date.now()))

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">API Keys</h1>
        <p className="text-muted text-sm mt-1">
          Automate sub-user creation, bandwidth allocation, and usage tracking. See the{' '}
          <a href="/docs/api" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">full API docs →</a>
        </p>
      </div>

      {/* Just-created key — shown once, never retrievable again */}
      {justCreated && (
        <div className="bg-accent-light border border-accent/30 rounded-xl p-6 mb-6">
          <h2 className="font-display font-bold text-base text-ink mb-2">Your new API key</h2>
          <p className="text-xs text-muted mb-3">
            Copy this now — for security we only show it once and can't display it again after you leave this page.
            {justRotatedNote ? ` ${justRotatedNote}` : ''}
          </p>
          <div className="bg-white border border-border rounded-lg p-4 flex items-center gap-3">
            <span className="font-mono text-xs text-ink flex-1 truncate select-all">{justCreated}</span>
            <button onClick={() => copy(justCreated, 'API key copied')}
              className="text-xs font-mono text-accent border border-accent/30 px-2.5 py-1 rounded-lg transition-colors flex-shrink-0">
              Copy
            </button>
          </div>
          <button onClick={() => setJustCreated(null)}
            className="text-xs text-muted hover:text-ink mt-3">
            Done, I've saved it
          </button>
        </div>
      )}

      {/* Key list + create */}
      <div className="bg-white border border-border rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-bold text-base text-ink">Your keys</h2>
          <div className="flex items-center gap-2">
            {activeKeys.length > 0 && (
              <button onClick={revokeAll} className="text-[10px] font-mono text-muted hover:text-red-500 underline">revoke all</button>
            )}
            <span className="text-[10px] font-mono bg-accent2-light text-accent2 px-2.5 py-1 rounded-full">
              {activeKeys.length} active
            </span>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-muted">Loading...</p>
        ) : loadError ? (
          <p className="text-sm text-red-500 mb-4">{loadError}{' '}
            <button onClick={loadKeys} className="underline hover:opacity-70">Retry</button>
          </p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted mb-4">No API keys yet.</p>
        ) : (
          <div className="flex flex-col gap-2 mb-4">
            {keys.map(k => (
              <div key={k.id} className={`border border-border rounded-lg p-3 ${k.revoked_at ? 'opacity-50' : ''}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-ink font-medium">{k.label}</div>
                    <div className="text-xs font-mono text-muted">
                      {k.key_prefix}••••••••
                      {k.revoked_at ? ' · revoked' : k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}${k.last_used_ip ? ` from ${k.last_used_ip}` : ''}` : ' · never used'}
                    </div>
                    {!k.revoked_at && (
                      <div className="text-[11px] font-mono text-muted mt-0.5">
                        {LEVEL_LABEL[levelOfScopes(k.scopes)]}
                        {k.expires_at ? (new Date(k.expires_at).getTime() <= Date.now()
                          ? ' · expired'
                          : ` · expires ${new Date(k.expires_at).toLocaleDateString()}`) : ' · no expiry'}
                        {k.allowed_ips && k.allowed_ips.length > 0 ? ` · IPs: ${k.allowed_ips.join(', ')}` : ' · any IP'}
                        {k.expires_at && new Date(k.expires_at).getTime() > Date.now() && new Date(k.expires_at).getTime() - Date.now() < 7 * 86_400_000 && (
                          <span className="text-amber-600"> · expiring soon — rotate it</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <button onClick={() => toggleActivity(k.id)}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                      Activity
                    </button>
                    {!k.revoked_at && (
                      <>
                        <button onClick={() => (editing === k.id ? setEditing(null) : startEdit(k))}
                          className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                          Edit
                        </button>
                        <button onClick={() => openRotate(k.id)}
                          className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                          Rotate
                        </button>
                        <button onClick={() => revokeKey(k.id)}
                          className="text-xs font-mono text-muted hover:text-red-500 border border-border hover:border-red-200 px-2.5 py-1 rounded-lg transition-colors">
                          Revoke
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {editing === k.id && (
                  <div className="mt-3 pt-3 border-t border-border flex flex-col gap-2">
                    <input value={editLabel} onChange={e => setEditLabel(e.target.value)} placeholder="Label"
                      className="bg-surface border border-border px-3 py-2 rounded-lg text-xs focus:outline-none focus:border-accent" />
                    <input value={editIps} onChange={e => setEditIps(e.target.value)} placeholder="Allowed IPs — empty = any IP"
                      className="bg-surface border border-border px-3 py-2 rounded-lg text-xs font-mono focus:outline-none focus:border-accent" />
                    <div className="flex flex-wrap gap-2">
                      <select value={editScope} onChange={e => setEditScope(e.target.value as AccessLevel)}
                        className="bg-surface border border-border px-3 py-2 rounded-lg text-xs focus:outline-none focus:border-accent">
                        <option value="full">Full access (read + write)</option>
                        <option value="read">Read-only</option>
                        {(canAllocate || scopeOf(k) === 'allocate') && <option value="allocate">Full access + allocate (requires narrow allowed IPs)</option>}
                        {(canAllocate || scopeOf(k) === 'allocate_only') && <option value="allocate_only">Read + allocate only (requires narrow allowed IPs)</option>}
                      </select>
                      <select value={editExpiry} onChange={e => setEditExpiry(e.target.value)}
                        className="bg-surface border border-border px-3 py-2 rounded-lg text-xs focus:outline-none focus:border-accent">
                        <option value="keep">Keep current expiry</option>
                        <option value="30">Expire in 30 days from now</option>
                        <option value="90">Expire in 90 days from now</option>
                        <option value="180">Expire in 180 days from now</option>
                        <option value="365">Expire in 1 year from now</option>
                        <option value="none">Never expire</option>
                      </select>
                    </div>
                    <p className="text-[11px] text-muted">Narrowing a key (fewer IPs, read-only, an earlier expiry) applies instantly; widening it asks you to confirm with 2FA / your password.</p>
                    <div className="flex gap-2">
                      <button onClick={() => saveEdit(k)} className="text-xs bg-accent text-white px-3 py-1.5 rounded-lg">Save</button>
                      <button onClick={() => setEditing(null)} className="text-xs text-muted hover:text-ink px-2">Cancel</button>
                    </div>
                  </div>
                )}
                {rotatingId === k.id && (
                  <div className="mt-3 pt-3 border-t border-border flex flex-col gap-2">
                    <label className="flex items-start gap-2 text-xs text-ink cursor-pointer">
                      <input type="radio" name={`grace-${k.id}`} checked={rotateGrace === '24'} onChange={() => setRotateGrace('24')} className="mt-0.5" />
                      <span>Keep the old key working for 24 hours <span className="text-muted">— time to deploy the new one without an outage.</span></span>
                    </label>
                    <label className="flex items-start gap-2 text-xs text-ink cursor-pointer">
                      <input type="radio" name={`grace-${k.id}`} checked={rotateGrace === '0'} onChange={() => setRotateGrace('0')} className="mt-0.5" />
                      <span>Revoke the old key now <span className="text-muted">— choose this if it leaked. Anything still using it stops immediately.</span></span>
                    </label>
                    <div className="flex gap-2">
                      <button onClick={() => rotateKey(k.id)} disabled={rotating} className="text-xs bg-accent text-white px-3 py-1.5 rounded-lg disabled:opacity-60">
                        {rotating ? 'Rotating…' : 'Rotate key'}
                      </button>
                      <button onClick={() => setRotatingId(null)} className="text-xs text-muted hover:text-ink px-2">Cancel</button>
                    </div>
                  </div>
                )}
                {activityFor === k.id && (
                  <div className="mt-3 pt-3 border-t border-border">
                    {activity === null ? (
                      <p className="text-xs text-muted">Loading…</p>
                    ) : activity.length === 0 ? (
                      <p className="text-xs text-muted">No changes made with this key in the last 30 days. (Read-only requests aren&rsquo;t logged.)</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {activity.map((a) => (
                          <div key={a.id} className="text-[11px] font-mono text-muted flex gap-2 flex-wrap">
                            <span>{new Date(a.created_at).toLocaleString()}</span>
                            <span className="text-ink">{a.method} {a.path.replace('/api/v1', '')}</span>
                            <span className={a.status >= 400 ? 'text-red-500' : ''}>{a.status}</span>
                            {a.ip && <span>{a.ip}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-2">
          <select value={newScope} onChange={e => setNewScope(e.target.value as AccessLevel)}
            className="bg-surface border border-border px-3 py-2 rounded-xl text-xs focus:outline-none focus:border-accent">
            <option value="full">Full access (read + write)</option>
            <option value="read">Read-only</option>
            {canAllocate && <option value="allocate">Full access + allocate bandwidth (requires narrow allowed IPs)</option>}
            {canAllocate && <option value="allocate_only">Read + allocate only — least privilege (requires narrow allowed IPs)</option>}
          </select>
          <select value={newExpiry} onChange={e => setNewExpiry(e.target.value)}
            className="bg-surface border border-border px-3 py-2 rounded-xl text-xs focus:outline-none focus:border-accent">
            <option value="">No expiry</option>
            <option value="30">Expires in 30 days</option>
            <option value="90">Expires in 90 days</option>
            <option value="180">Expires in 180 days</option>
            <option value="365">Expires in 1 year</option>
          </select>
        </div>
        <input value={newIps} onChange={e => setNewIps(e.target.value)}
          placeholder={newScope === 'allocate' || newScope === 'allocate_only' ? 'Allowed IPs (required) — single addresses or blocks no wider than /24, e.g. 203.0.113.4, 198.51.100.0/24' : 'Allowed IPs (optional) — e.g. 203.0.113.4, 198.51.100.0/24'}
          className="w-full bg-surface border border-border px-4 py-2 rounded-xl text-xs font-mono focus:outline-none focus:border-accent transition-colors mb-2" />
        <div className="flex gap-2">
          <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Key label (optional)"
            className="flex-1 bg-surface border border-border px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
          <button onClick={createKey} disabled={creating}
            className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity flex-shrink-0">
            {creating ? 'Creating...' : 'Create new key'}
          </button>
        </div>
        <p className="text-xs text-muted font-light mt-3">
          Keep your keys private. Never expose them in client-side JavaScript or public repositories.
        </p>
      </div>

      {/* Endpoints */}
      <div className="bg-white border border-border rounded-xl p-6">
        <h2 className="font-display font-bold text-base text-ink mb-5">API Reference</h2>
        <div className="flex flex-col gap-4">
          {ENDPOINTS.map(ep => (
            <div key={ep.title} className="border border-border rounded-xl overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-2.5 bg-surface border-b border-border">
                <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                  ep.method === 'GET' ? 'bg-accent-light text-accent' : 'bg-accent2-light text-accent2'
                }`}>{ep.method}</span>
                <span className="font-mono text-xs text-ink">{ep.path}</span>
                <span className="text-xs text-muted ml-auto">{ep.title}</span>
                <button onClick={() => copy(ep.example, 'Command copied')}
                  className="text-[10px] font-mono text-muted hover:text-ink border border-border px-2 py-0.5 rounded transition-colors">
                  copy
                </button>
              </div>
              <pre className="px-4 py-3 text-xs font-mono text-ink2 overflow-x-auto bg-white leading-5">{ep.example}</pre>
            </div>
          ))}
        </div>

        <div className="mt-5 pt-5 border-t border-border">
          <p className="text-xs text-muted">
            Base URL: <span className="font-mono text-ink">https://globproxy.com</span> ·
            Auth header: <span className="font-mono text-ink">Authorization: Bearer YOUR_KEY</span>
          </p>
          <p className="text-xs text-muted mt-2">
            Also available: sticky sessions, bulk operations, reseller allocation, webhook management (rotate secret, delivery log, redeliver), idempotent creates, whitelist bulk add/remove — see the{' '}
            <a href="/docs/api" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">full API docs</a> for those and every parameter.
          </p>
        </div>
      </div>
    </div>
  )
}
