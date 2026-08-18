'use client'
import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'

const ENDPOINTS = [
  {
    method: 'GET', title: 'Bandwidth balance',
    path: '/api/v1/account/bandwidth',
    example: `curl https://globproxy.com/api/v1/account/bandwidth \\
  -H "Authorization: Bearer YOUR_KEY"`,
  },
  {
    method: 'GET', title: 'List sub-users',
    path: '/api/v1/sub-users',
    example: `curl https://globproxy.com/api/v1/sub-users \\
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
]

type ApiKeyMeta = {
  id: string
  key_prefix: string
  label: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export default function ApiKeysClient() {
  const [keys, setKeys] = useState<ApiKeyMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [justCreated, setJustCreated] = useState<string | null>(null) // plaintext, shown once

  async function loadKeys() {
    setLoading(true)
    const res = await fetch('/api/dashboard/api-keys')
    const data = await res.json().catch(() => ({}))
    if (res.ok) setKeys(data.keys ?? [])
    setLoading(false)
  }

  useEffect(() => { loadKeys() }, [])

  async function createKey() {
    setCreating(true)
    const res = await fetch('/api/dashboard/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: newLabel.trim() || 'Default key' }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) {
      toast.error(data.error ?? 'Failed to create key')
    } else {
      setJustCreated(data.key)
      setNewLabel('')
      await loadKeys()
    }
    setCreating(false)
  }

  async function revokeKey(id: string) {
    if (!confirm('Revoke this key? Anything using it will stop working immediately.')) return
    const res = await fetch('/api/dashboard/api-keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) toast.error(data.error ?? 'Failed to revoke key')
    else { toast.success('Key revoked'); loadKeys() }
  }

  function copy(text: string, label = 'Copied') {
    navigator.clipboard.writeText(text)
    toast.success(label)
  }

  const activeKeys = keys.filter(k => !k.revoked_at)

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
          </p>
          <div className="bg-white border border-border rounded-lg p-4 flex items-center gap-3">
            <span className="font-mono text-xs text-ink flex-1 truncate">{justCreated}</span>
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
          <span className="text-[10px] font-mono bg-accent2-light text-accent2 px-2.5 py-1 rounded-full">
            {activeKeys.length} active
          </span>
        </div>

        {loading ? (
          <p className="text-sm text-muted">Loading...</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted mb-4">No API keys yet.</p>
        ) : (
          <div className="flex flex-col gap-2 mb-4">
            {keys.map(k => (
              <div key={k.id} className={`flex items-center justify-between border border-border rounded-lg p-3 ${k.revoked_at ? 'opacity-50' : ''}`}>
                <div>
                  <div className="text-sm text-ink font-medium">{k.label}</div>
                  <div className="text-xs font-mono text-muted">
                    {k.key_prefix}••••••••
                    {k.revoked_at ? ' · revoked' : k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}` : ' · never used'}
                  </div>
                </div>
                {!k.revoked_at && (
                  <button onClick={() => revokeKey(k.id)}
                    className="text-xs font-mono text-muted hover:text-red-500 border border-border hover:border-red-200 px-3 py-1 rounded-lg transition-colors">
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

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
            Also available: removing a single whitelisted IP, and bulk add/remove — see the{' '}
            <a href="/docs/api" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">full API docs</a> for those and every parameter.
          </p>
        </div>
      </div>
    </div>
  )
}
