'use client'
import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { buildProxyUsername, getProxyPort, genSessionId } from '@/lib/proxyEndpoint'
import SessionManager from '@/components/dashboard/SessionManager'
import toast from 'react-hot-toast'
import clsx from 'clsx'

interface Props { cred: any; index: number }

export default function ProxyCard({ cred, index }: Props) {
  const router = useRouter()
  const [showPass, setShowPass] = useState(false)
  const [showSnippets, setShowSnippets] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const host = cred.host || 'proxy.globproxy.com'
  // Port depends on protocol AND session type (sticky vs rotating) — not
  // protocol alone. See lib/proxyEndpoint.ts.
  const port = cred.port || getProxyPort(cred.protocol, cred.session_type)
  const baseUser = cred.geonode_username || '—'
  const pass = cred.geonode_password || '—'
  const pct  = cred.gb_allocated > 0 ? (cred.gb_used / cred.gb_allocated) * 100 : 0

  // New credentials can 407 for a few minutes after creation — Geonode's edge
  // gateway nodes appear to cache the sub-user list and sync periodically
  // rather than checking a live DB on every connection, so a brand-new
  // sub-user can exist on Geonode's side before the gateway node you connect
  // to has picked it up. Not a bug on our end; just needs the UI to say so.
  const isWarmingUp = cred.activated_at &&
    (Date.now() - new Date(cred.activated_at).getTime()) < 10 * 60 * 1000

  const isSticky = cred.session_type === 'sticky'

  // Stable per-render session IDs for ROTATING credentials only — sticky
  // sessions are now real, persisted records managed via SessionManager
  // below, not ephemeral ones regenerated on every render.
  const count = cred.endpoint_count || 1
  const sessionIds = useMemo(
    () => Array.from({ length: count }, () => genSessionId()),
    [cred.id, count, cred.session_type]
  )

  const endpoints: string[] = isSticky ? [] : sessionIds.map((sid) =>
    `${host}:${port}:${buildProxyUsername(baseUser, cred, sid)}:${pass}`
  )
  // For sticky, show the targeting prefix with no session baked in — the
  // real, usable endpoint is whatever session the user creates below.
  const user = isSticky
    ? buildProxyUsername(baseUser, { ...cred, session_type: 'rotating' })
    : (endpoints.length ? buildProxyUsername(baseUser, cred, sessionIds[0]) : baseUser)

  function copy(text: string, label = 'Copied') {
    navigator.clipboard.writeText(text)
    toast.success(label)
  }

  function copyAll() {
    copy(endpoints.join('\n'), `${endpoints.length} endpoint${endpoints.length > 1 ? 's' : ''} copied`)
  }

  function downloadTxt() {
    const name = cred.label || `proxy-session-${index + 1}`
    const blob = new Blob([endpoints.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${name.toLowerCase().replace(/\s+/g, '-')}.txt`
    a.click(); URL.revokeObjectURL(url)
    toast.success('Downloaded')
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch(`/api/dashboard/proxies/${cred.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${session?.access_token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Proxy deleted')
      router.refresh()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setDeleting(false); setConfirmDelete(false)
    }
  }

  // IP verify curl command
  const verifyCurl = `curl -x ${cred.protocol === 'socks5' ? 'socks5' : 'http'}://${user}:${pass}@${host}:${port} https://ipinfo.io/json`

  // Integration snippets
  const pySnippet = `import requests

proxies = {
    "http":  "http://${user}:${pass}@${host}:${port}",
    "https": "http://${user}:${pass}@${host}:${port}",
}

response = requests.get("https://ipinfo.io/json", proxies=proxies)
print(response.json())  # shows your proxy IP and location`

  const nodeSnippet = `const { HttpsProxyAgent } = require("https-proxy-agent");
const fetch = require("node-fetch");

const agent = new HttpsProxyAgent(
  "http://${user}:${pass}@${host}:${port}"
);

const res = await fetch("https://ipinfo.io/json", { agent });
console.log(await res.json()); // shows proxy IP and location`

  const browserSnippet = `// Chrome / Firefox extension settings:
// 
// Host:     ${host}
// Port:     ${port}
// Protocol: ${cred.protocol === 'socks5' ? 'SOCKS5' : 'HTTP'}
// Username: ${user}
// Password: ${pass}
//
// Recommended extension: Proxy SwitchyOmega (Chrome/Firefox)`

  const statusColor = cred.status === 'active' ? 'text-accent2 bg-accent2-light' : cred.status === 'pending' ? 'text-yellow-600 bg-yellow-50' : 'text-muted bg-surface border border-border'

  return (
    <div className="bg-white border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between p-5 pb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-medium text-ink">{cred.label || `Session #${index + 1}`}</span>
            <span className={clsx('text-[10px] font-mono px-2 py-0.5 rounded-full', statusColor)}>{cred.status}</span>
            <span className="text-[10px] font-mono bg-surface text-muted border border-border px-2 py-0.5 rounded-full">{cred.session_type}</span>
            <span className="text-[10px] font-mono bg-surface text-muted border border-border px-2 py-0.5 rounded-full">{(cred.protocol || 'http').toUpperCase()}</span>
            {cred.sticky_duration && (
              <span className="text-[10px] font-mono bg-accent-light text-accent px-2 py-0.5 rounded-full">{cred.sticky_duration}min sticky</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            {cred.country && <span className="font-mono">{cred.country}</span>}
            {cred.state && <><span>·</span><span className="font-mono">{cred.state}</span></>}
            {cred.city && <><span>·</span><span className="font-mono">{cred.city}</span></>}
          </div>
        </div>
        <div className="text-right flex-shrink-0 ml-4">
          <div className="font-mono text-sm font-medium text-ink">{cred.gb_allocated} GB</div>
          <div className="text-xs text-muted">allocated</div>
        </div>
      </div>

      {/* GB usage bar */}
      <div className="px-5 pb-4">
        <div className="flex justify-between text-[11px] font-mono text-muted mb-1">
          <span>{(cred.gb_used || 0).toFixed(3)} GB used</span>
          <span>{Math.max(0, cred.gb_allocated - (cred.gb_used || 0)).toFixed(3)} GB left</span>
        </div>
        <div className="bg-surface rounded-full h-1.5 overflow-hidden">
          <div className={clsx('h-full rounded-full transition-all', pct > 80 ? 'bg-red-400' : pct > 50 ? 'bg-amber-400' : 'bg-accent2')}
            style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      </div>

      {cred.status === 'pending' ? (
        <div className="mx-5 mb-5 text-xs text-yellow-700 bg-yellow-50 border border-yellow-100 rounded-lg px-4 py-3 font-mono">
          ⏳ Credentials are being provisioned. This usually takes under a minute. Refresh the page or contact support if this persists.
        </div>
      ) : cred.status === 'active' ? (
        <>
          {isWarmingUp && (
            <div className="mx-5 mb-4 text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 font-mono">
              🌐 New credentials can take a few minutes to start working (you may see a 407 error at first) while they sync across the proxy network. If it doesn't connect immediately, wait a couple of minutes and try again.
            </div>
          )}
          {/* Credential fields */}
          <div className="mx-5 mb-4 bg-surface border border-border rounded-lg overflow-hidden">
            {[
              ['Host', host, host],
              ['Port', String(port), String(port)],
              ['Username', user, user],
              ['Password', showPass ? pass : '••••••••••••••••', pass],
            ].map(([label, display, copyVal]) => (
              <div key={label} className="flex items-center border-b border-border last:border-none px-3 py-2">
                <span className="text-[10px] font-mono text-muted w-20 flex-shrink-0">{label}</span>
                <span className="text-xs font-mono text-ink flex-1 truncate">{display}</span>
                {label === 'Password' && (
                  <button onClick={() => setShowPass(!showPass)}
                    className="text-[10px] font-mono text-muted hover:text-ink border border-border px-2 py-0.5 rounded mr-1.5 transition-colors">
                    {showPass ? 'hide' : 'show'}
                  </button>
                )}
                <button onClick={() => copy(copyVal, `${label} copied`)}
                  className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2 py-0.5 rounded transition-colors">
                  copy
                </button>
              </div>
            ))}
          </div>

          {/* Endpoint strings — rotating shows the simple block; sticky gets
              real, persisted, manageable sessions instead of ephemeral ones */}
          {isSticky ? (
            <div className="mx-5 mb-4">
              <SessionManager
                credentialId={cred.id}
                cred={cred}
                host={host}
                port={port}
                baseUser={baseUser}
                pass={pass}
                onCopy={copy}
              />
            </div>
          ) : (
            <div className="mx-5 mb-4">
              <div className="bg-ink rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                  <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
                    Endpoint strings — host:port:user:pass
                    {count > 1 ? ` (${count} endpoints)` : ''}
                  </span>
                  <div className="flex gap-2">
                    <button onClick={copyAll}
                      className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2.5 py-1 rounded transition-colors">
                      copy all
                    </button>
                    <button onClick={downloadTxt}
                      className="text-[10px] font-mono text-white/50 hover:text-white border border-white/10 px-2.5 py-1 rounded transition-colors">
                      .txt
                    </button>
                  </div>
                </div>
                <div className="px-3 py-3 max-h-36 overflow-y-auto">
                  {endpoints.map((ep, i) => (
                    <div key={i} className="font-mono text-[11px] text-white/70 leading-5 break-all">{ep}</div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* IP verify */}
          <div className="mx-5 mb-4">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1.5">Verify exit IP</div>
            <div className="bg-ink rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                <span className="text-[10px] font-mono text-white/40">Run in your terminal</span>
                <button onClick={() => copy(verifyCurl, 'Command copied')}
                  className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2.5 py-1 rounded transition-colors">
                  copy
                </button>
              </div>
              <div className="px-3 py-2.5 font-mono text-[11px] text-white/70 break-all leading-5">{verifyCurl}</div>
            </div>
          </div>

          {/* Integration snippets */}
          <div className="mx-5 mb-5">
            <button onClick={() => setShowSnippets(!showSnippets)}
              className="flex items-center gap-2 text-xs text-muted hover:text-ink transition-colors">
              <span className={`transition-transform ${showSnippets ? 'rotate-90' : ''}`}>▶</span>
              Integration snippets (Python, Node.js, Browser)
            </button>
            {showSnippets && (
              <div className="mt-3 flex flex-col gap-3">
                {[
                  ['Python / requests', pySnippet, 'python'],
                  ['Node.js / node-fetch', nodeSnippet, 'javascript'],
                  ['Browser extension', browserSnippet, 'bash'],
                ].map(([title, code, lang]) => (
                  <div key={title} className="bg-ink rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                      <span className="text-[10px] font-mono text-white/40">{title}</span>
                      <button onClick={() => copy(code as string, 'Snippet copied')}
                        className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2.5 py-1 rounded transition-colors">
                        copy
                      </button>
                    </div>
                    <pre className="px-3 py-3 text-[11px] font-mono text-white/70 overflow-x-auto whitespace-pre-wrap leading-5">{code}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}

      {/* Delete */}
      <div className="px-5 pb-5 flex items-center justify-between">
        <div className="text-xs text-muted font-mono">
          {cred.created_by && cred.created_by !== cred.user_id
            ? '⚠ Allocated by reseller — cannot delete'
            : 'Deleting returns allocated GB to your account'}
        </div>
        {(!cred.created_by || cred.created_by === cred.user_id) && (
          <button onClick={handleDelete} disabled={deleting}
            className={clsx(
              'text-xs font-mono px-3 py-1.5 rounded-lg border transition-all disabled:opacity-50',
              confirmDelete
                ? 'bg-red-500 text-white border-red-500 hover:opacity-90'
                : 'border-border text-muted hover:border-red-300 hover:text-red-500'
            )}>
            {deleting ? 'Deleting...' : confirmDelete ? 'Confirm delete' : 'Delete session'}
          </button>
        )}
      </div>
    </div>
  )
}
