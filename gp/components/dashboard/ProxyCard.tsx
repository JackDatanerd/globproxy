'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Cred {
  id: string
  label: string | null
  status: string
  session_type: string
  sticky_duration: number | null
  endpoint_count: number | null
  protocol: string | null
  country: string | null
  state: string | null
  city: string | null
  host: string | null
  port: number | null
  geonode_username: string | null
  geonode_password: string | null
  gb_allocated: number
  gb_used: number | null
  activated_at: string | null
  created_at: string
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      onClick={copy}
      className="text-[10px] font-mono px-2 py-0.5 rounded border border-border text-muted hover:text-accent hover:border-accent/40 transition-colors"
    >
      {copied ? '✓ copied' : `copy ${label}`}
    </button>
  )
}

function buildEndpoints(cred: Cred): string[] {
  if (!cred.geonode_username || !cred.geonode_password || !cred.host || !cred.port) return []
  const count = cred.endpoint_count ?? 1
  const lines: string[] = []
  for (let i = 1; i <= count; i++) {
    let user = cred.geonode_username
    if (cred.session_type === 'sticky') {
      user = `${user}-session-${i}`
    }
    lines.push(`${cred.host}:${cred.port}:${user}:${cred.geonode_password}`)
  }
  return lines
}

function buildCurlCommand(cred: Cred): string {
  if (!cred.geonode_username || !cred.geonode_password || !cred.host || !cred.port) return ''
  const proto = cred.protocol === 'socks5' ? 'socks5h' : 'http'
  return `curl -x ${proto}://${cred.geonode_username}:${cred.geonode_password}@${cred.host}:${cred.port} https://ipinfo.io/json`
}

export default function ProxyCard({ cred }: { cred: Cred }) {
  const router = useRouter()
  const [showPassword, setShowPassword] = useState(false)
  const [showSnippets, setShowSnippets] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const endpoints = buildEndpoints(cred)
  const curlCmd = buildCurlCommand(cred)
  const locationLabel = [cred.country?.toUpperCase(), cred.state, cred.city].filter(Boolean).join(' · ')
  const gbPct = cred.gb_allocated > 0 ? ((cred.gb_used ?? 0) / cred.gb_allocated) * 100 : 0

  async function handleDelete() {
    if (!confirm(`Delete "${cred.label ?? 'this session'}"? Allocated GB will be returned to your account.`)) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/dashboard/proxies/${cred.id}`, { method: 'DELETE' })
      if (res.ok) {
        router.refresh()
      } else {
        const d = await res.json()
        alert(d.error ?? 'Delete failed')
      }
    } catch {
      alert('Network error. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  function downloadEndpoints() {
    const content = endpoints.join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${cred.label ?? 'proxies'}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const pythonSnippet = cred.geonode_username && cred.geonode_password
    ? `import requests

proxies = {
    "http":  "http://${cred.geonode_username}:${cred.geonode_password}@${cred.host}:${cred.port}",
    "https": "http://${cred.geonode_username}:${cred.geonode_password}@${cred.host}:${cred.port}",
}

r = requests.get("https://ipinfo.io/json", proxies=proxies)
print(r.json())`
    : ''

  const nodeSnippet = cred.geonode_username && cred.geonode_password
    ? `const { HttpsProxyAgent } = require('https-proxy-agent')
const fetch = require('node-fetch')

const agent = new HttpsProxyAgent(
  'http://${cred.geonode_username}:${cred.geonode_password}@${cred.host}:${cred.port}'
)

fetch('https://ipinfo.io/json', { agent })
  .then(r => r.json())
  .then(console.log)`
    : ''

  return (
    <div className="bg-white border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-medium text-ink">{cred.label ?? 'Unnamed session'}</span>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                cred.status === 'active' ? 'bg-accent2-light text-accent2'
                : cred.status === 'pending' ? 'bg-yellow-50 text-yellow-600'
                : 'bg-red-50 text-red-400'
              }`}>{cred.status}</span>
              <span className="text-[10px] font-mono bg-surface text-muted px-2 py-0.5 rounded-full">{cred.session_type}</span>
              {cred.protocol && (
                <span className="text-[10px] font-mono bg-surface text-muted px-2 py-0.5 rounded-full">{cred.protocol.toUpperCase()}</span>
              )}
            </div>
            {locationLabel && (
              <div className="text-xs text-muted">{locationLabel}</div>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-mono text-ink">{cred.gb_allocated} GB</div>
            <div className="text-xs text-muted">allocated</div>
          </div>
        </div>

        {/* GB usage mini bar */}
        {cred.gb_allocated > 0 && (
          <div className="mt-3">
            <div className="bg-surface rounded-full h-1.5 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-accent to-sky-400"
                style={{ width: `${Math.min(gbPct, 100)}%` }}
              />
            </div>
            <div className="text-[10px] font-mono text-muted mt-1">
              {(cred.gb_used ?? 0).toFixed(2)} / {cred.gb_allocated} GB used
            </div>
          </div>
        )}
      </div>

      {/* Active credential block */}
      {cred.status === 'active' && cred.geonode_username && (
        <div className="border-t border-border px-5 py-4">
          {/* Credential fields */}
          <div className="bg-surface rounded-lg p-3 mb-3">
            <div className="grid grid-cols-1 gap-2">
              {[
                { label: 'Host', value: cred.host ?? '', copyLabel: 'host' },
                { label: 'Port', value: String(cred.port ?? ''), copyLabel: 'port' },
                { label: 'Username', value: cred.geonode_username ?? '', copyLabel: 'user' },
                {
                  label: 'Password',
                  value: showPassword ? (cred.geonode_password ?? '') : '••••••••••••••••',
                  copyLabel: 'pass',
                  rawValue: cred.geonode_password ?? '',
                },
              ].map(({ label, value, copyLabel, rawValue }) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-muted w-16 flex-shrink-0">{label}</span>
                  <span className="text-xs font-mono text-ink flex-1 truncate">{value}</span>
                  <CopyButton text={rawValue ?? value} label={copyLabel} />
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowPassword(p => !p)}
              className="text-[10px] font-mono text-muted hover:text-accent mt-2 transition-colors"
            >
              {showPassword ? 'hide password' : 'show password'}
            </button>
          </div>

          {/* Endpoint strings */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-ink">
                Endpoint string{endpoints.length > 1 ? 's' : ''}
              </span>
              <div className="flex gap-2">
                <CopyButton text={endpoints.join('\n')} label="all" />
                <button
                  onClick={downloadEndpoints}
                  className="text-[10px] font-mono px-2 py-0.5 rounded border border-border text-muted hover:text-accent hover:border-accent/40 transition-colors"
                >
                  download .txt
                </button>
              </div>
            </div>
            <div className="bg-[#0f1117] rounded-lg p-3 max-h-40 overflow-y-auto">
              {endpoints.map((ep, i) => (
                <div key={i} className="text-[11px] font-mono text-green-400 leading-5 break-all">{ep}</div>
              ))}
            </div>
          </div>

          {/* IP verify command */}
          {curlCmd && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-ink">Verify IP (run in terminal)</span>
                <CopyButton text={curlCmd} label="command" />
              </div>
              <div className="bg-[#0f1117] rounded-lg p-3">
                <div className="text-[11px] font-mono text-yellow-300 break-all leading-5">{curlCmd}</div>
              </div>
            </div>
          )}

          {/* Integration snippets toggle */}
          <button
            onClick={() => setShowSnippets(s => !s)}
            className="text-xs text-accent hover:underline font-mono"
          >
            {showSnippets ? '▲ hide snippets' : '▼ integration snippets'}
          </button>

          {showSnippets && (
            <div className="mt-3 flex flex-col gap-3">
              {/* Python */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono text-muted uppercase tracking-wider">Python · requests</span>
                  <CopyButton text={pythonSnippet} label="python" />
                </div>
                <div className="bg-[#0f1117] rounded-lg p-3 overflow-x-auto">
                  <pre className="text-[11px] font-mono text-blue-300 leading-5">{pythonSnippet}</pre>
                </div>
              </div>
              {/* Node */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono text-muted uppercase tracking-wider">Node.js · node-fetch</span>
                  <CopyButton text={nodeSnippet} label="node" />
                </div>
                <div className="bg-[#0f1117] rounded-lg p-3 overflow-x-auto">
                  <pre className="text-[11px] font-mono text-blue-300 leading-5">{nodeSnippet}</pre>
                </div>
              </div>
              {/* Chrome */}
              <div className="bg-surface rounded-lg p-3">
                <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">Chrome / Browser</div>
                <div className="text-xs text-ink leading-5">
                  Use a proxy extension like <strong>Proxy SwitchyOmega</strong> or <strong>FoxyProxy</strong>.<br />
                  Set type to <strong>{cred.protocol?.toUpperCase() ?? 'HTTP'}</strong>, server to <strong>{cred.host}</strong>, port to <strong>{cred.port}</strong>, then enter your username and password when prompted.
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Pending state */}
      {cred.status === 'pending' && (
        <div className="border-t border-border px-5 py-4">
          <div className="text-xs text-yellow-600 bg-yellow-50 px-3 py-2 rounded-lg font-mono">
            ⏳ Activates upon payment confirmation
          </div>
        </div>
      )}

      {/* Footer actions */}
      <div className="border-t border-border px-5 py-3 flex items-center justify-between bg-surface/50">
        <span className="text-[10px] font-mono text-muted">
          Created {new Date(cred.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          {cred.sticky_duration ? ` · ${cred.sticky_duration}min sticky` : ''}
          {cred.endpoint_count && cred.endpoint_count > 1 ? ` · ${cred.endpoint_count} endpoints` : ''}
        </span>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-xs font-mono text-red-400 hover:text-red-600 transition-colors disabled:opacity-50"
        >
          {deleting ? 'deleting…' : 'delete session'}
        </button>
      </div>
    </div>
  )
}
