'use client'
import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { buildProxyUsername, getProxyPort, genSessionId } from '@/lib/proxyEndpoint'
import { formatGb, formatPct } from '@/lib/format'
import SessionManager from '@/components/dashboard/SessionManager'
import toast from 'react-hot-toast'
import clsx from 'clsx'

interface Props { cred: any; index: number; expanded: boolean; onToggle: () => void }

type Tab = 'cred' | 'endpoints' | 'code'
type Lang = 'py' | 'node' | 'browser'

// Row-based redesign: collapsed by default (status communicated by the left
// rail, not by reading text), expands to the same credential/endpoint/code
// detail the old always-open card showed, just organized into tabs so the
// expanded state doesn't turn into another giant scroll once someone has a
// handful of sessions.
export default function ProxyCard({ cred, index, expanded, onToggle }: Props) {
  const router = useRouter()
  const [showPass, setShowPass] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [tab, setTab] = useState<Tab>('cred')
  const [lang, setLang] = useState<Lang>('py')
  const [justCopied, setJustCopied] = useState(false)

  const host = cred.host || 'proxy.globproxy.com'
  const port = cred.port || getProxyPort(cred.protocol, cred.session_type)
  const baseUser = cred.geonode_username || '—'
  const pass = cred.geonode_password || '—'
  const gbAllocated = cred.gb_allocated || 0
  const gbUsed = cred.gb_used || 0
  const pct = gbAllocated > 0 ? (gbUsed / gbAllocated) * 100 : 0

  const isWarmingUp = cred.activated_at &&
    (Date.now() - new Date(cred.activated_at).getTime()) < 10 * 60 * 1000

  const isSticky = cred.session_type === 'sticky'
  const isSocks5 = cred.protocol === 'socks5'
  const canDelete = !cred.created_by || cred.created_by === cred.user_id

  const count = cred.endpoint_count || 1
  const sessionIds = useMemo(
    () => Array.from({ length: count }, () => genSessionId()),
    [cred.id, count, cred.session_type]
  )

  const endpoints: string[] = isSticky ? [] : sessionIds.map((sid) =>
    `${host}:${port}:${buildProxyUsername(baseUser, cred, sid)}:${pass}`
  )
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

  function quickCopy(e: React.MouseEvent) {
    e.stopPropagation()
    if (!endpoints.length) return
    navigator.clipboard.writeText(endpoints[0])
    setJustCopied(true)
    toast.success('Endpoint copied')
    setTimeout(() => setJustCopied(false), 1300)
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

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
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

  const verifyCurl = `curl -x ${isSocks5 ? 'socks5' : 'http'}://${user}:${pass}@${host}:${port} https://ipinfo.io/json`

  const pySnippet = isSocks5 ? `# pip install "requests[socks]"
import requests

proxies = {
    "http":  "socks5h://${user}:${pass}@${host}:${port}",
    "https": "socks5h://${user}:${pass}@${host}:${port}",
}

response = requests.get("https://ipinfo.io/json", proxies=proxies)
print(response.json())  # shows your proxy IP and location` : `import requests

proxies = {
    "http":  "http://${user}:${pass}@${host}:${port}",
    "https": "http://${user}:${pass}@${host}:${port}",
}

response = requests.get("https://ipinfo.io/json", proxies=proxies)
print(response.json())  # shows your proxy IP and location`

  const nodeSnippet = isSocks5 ? `// npm install socks-proxy-agent
const { SocksProxyAgent } = require("socks-proxy-agent");
const fetch = require("node-fetch");

const agent = new SocksProxyAgent(
  "socks5h://${user}:${pass}@${host}:${port}"
);

const res = await fetch("https://ipinfo.io/json", { agent });
console.log(await res.json()); // shows proxy IP and location` : `const { HttpsProxyAgent } = require("https-proxy-agent");
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
// Protocol: ${isSocks5 ? 'SOCKS5' : 'HTTP'}
// Username: ${user}
// Password: ${pass}
//
// Recommended extension: Proxy SwitchyOmega (Chrome/Firefox)`

  // Rail color — instant status read without opening the row. Pending and
  // warming-up are transient states; hot means the credential is close to
  // running out of its allocated GB.
  const railColor =
    cred.status === 'pending' ? 'bg-amber-500'
    : isWarmingUp ? 'bg-accent'
    : cred.status === 'active' && pct >= 85 ? 'bg-red-400'
    : cred.status === 'active' ? 'bg-accent2'
    : 'bg-border'

  const usageFillColor = pct > 80 ? 'bg-red-400' : pct > 50 ? 'bg-amber-400' : 'bg-accent2'

  const statusBadge = cred.status === 'active'
    ? 'text-accent2 bg-accent2-light'
    : cred.status === 'pending'
    ? 'text-amber-600 bg-amber-50'
    : 'text-muted bg-surface border border-border'

  return (
    <div className={clsx('relative bg-white border rounded-xl overflow-hidden transition-colors', expanded ? 'border-accent/30' : 'border-border hover:border-ink2/20')}>
      <div className={clsx('absolute left-0 top-0 bottom-0 w-[3px] rounded-l-xl', railColor)} />

      {/* Collapsed row header — click to expand */}
      <div onClick={onToggle} className="flex items-center gap-4 pl-6 pr-4 py-3.5 cursor-pointer select-none">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-ink truncate">{cred.label || `Session #${index + 1}`}</span>
            <span className={clsx('text-[9px] font-mono px-2 py-0.5 rounded-full uppercase tracking-wide', statusBadge)}>{cred.status}</span>
            {isWarmingUp && cred.status === 'active' && (
              <span className="text-[9px] font-mono px-2 py-0.5 rounded-full uppercase tracking-wide text-accent bg-accent-light">warming up</span>
            )}
            {cred.created_by && cred.created_by !== cred.user_id && (
              <span className="text-[9px] font-mono px-2 py-0.5 rounded-full uppercase tracking-wide text-muted bg-surface border border-border">via reseller</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-mono text-muted mt-0.5">
            <span>{cred.session_type}</span><span>·</span><span>{(cred.protocol || 'http').toUpperCase()}</span>
            {cred.sticky_duration && <><span>·</span><span>{cred.sticky_duration}min sticky</span></>}
            {(cred.country || cred.city) && <><span>·</span><span>{[cred.city, cred.country].filter(Boolean).join(', ')}</span></>}
          </div>
        </div>

        {cred.status === 'active' && gbAllocated > 0 && (
          <div className="w-36 flex-shrink-0 hidden sm:block">
            <div className="bg-surface rounded-full h-[5px] overflow-hidden">
              <div className={clsx('h-full rounded-full', usageFillColor)} style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
            <div className="flex justify-between text-[10px] font-mono text-muted mt-1">
              <span>{formatGb(gbUsed)} / {formatGb(gbAllocated)} GB</span>
              <span>{formatPct(gbUsed, gbAllocated, 0)}%</span>
            </div>
          </div>
        )}

        {cred.status === 'active' && !isSticky && endpoints.length > 0 && (
          <button onClick={quickCopy} title="Quick copy endpoint"
            className={clsx(
              'w-8 h-8 rounded-lg border flex items-center justify-center transition-colors flex-shrink-0',
              justCopied ? 'border-accent2 text-accent2 bg-accent2-light' : 'border-border text-ink2 hover:border-accent hover:text-accent hover:bg-accent-light'
            )}>
            {justCopied ? '✓' : '⧉'}
          </button>
        )}

        <span className={clsx('text-muted transition-transform flex-shrink-0', expanded && 'rotate-90')}>▶</span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border px-6 pb-5 pt-4">
          {cred.status === 'pending' && (
            <div className="mb-4 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 font-mono">
              ⏳ Credentials are being provisioned. This usually takes under a minute. Refresh the page or contact support if this persists.
            </div>
          )}
          {cred.status === 'active' && isWarmingUp && (
            <div className="mb-4 text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 font-mono">
              🌐 New credentials can take a few minutes to start working (you may see a 407 error at first) while they sync across the proxy network. If it doesn't connect immediately, wait a couple of minutes and try again.
            </div>
          )}

          {cred.status === 'active' && (
            <>
              {/* Tabs */}
              <div className="flex items-center gap-5 border-b border-border mb-4">
                <button onClick={() => setTab('cred')}
                  className={clsx('text-xs font-mono pb-2 -mb-px border-b-2 transition-colors', tab === 'cred' ? 'text-ink border-accent font-medium' : 'text-muted border-transparent hover:text-ink')}>
                  Credentials
                </button>
                <button onClick={() => setTab('endpoints')}
                  className={clsx('text-xs font-mono pb-2 -mb-px border-b-2 transition-colors', tab === 'endpoints' ? 'text-ink border-accent font-medium' : 'text-muted border-transparent hover:text-ink')}>
                  {isSticky ? 'Sticky sessions' : `Endpoints (${count})`}
                </button>
                <button onClick={() => setTab('code')}
                  className={clsx('text-xs font-mono pb-2 -mb-px border-b-2 transition-colors', tab === 'code' ? 'text-ink border-accent font-medium' : 'text-muted border-transparent hover:text-ink')}>
                  Code snippets
                </button>
              </div>

              {tab === 'cred' && (
                <div className="bg-surface border border-border rounded-lg overflow-hidden mb-2">
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
              )}

              {tab === 'endpoints' && (
                isSticky ? (
                  <div className="mb-2">
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
                  <div className="bg-ink rounded-lg overflow-hidden mb-2">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                      <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">host:port:user:pass</span>
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
                )
              )}

              {tab === 'code' && (
                <div className="mb-2">
                  <div className="mb-3">
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

                  <div className="flex gap-2 mb-3">
                    {(['py', 'node', 'browser'] as const).map(l => (
                      <button key={l} onClick={() => setLang(l)}
                        className={clsx('text-[10.5px] font-mono px-3 py-1.5 rounded-full border transition-colors',
                          lang === l ? 'bg-ink text-white border-ink' : 'bg-white text-ink2 border-border hover:border-ink2/40')}>
                        {l === 'py' ? 'Python' : l === 'node' ? 'Node.js' : 'Browser ext.'}
                      </button>
                    ))}
                  </div>

                  {lang === 'py' && (
                    <div className="bg-ink rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                        <span className="text-[10px] font-mono text-white/40">Python / requests</span>
                        <button onClick={() => copy(pySnippet, 'Snippet copied')}
                          className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2.5 py-1 rounded transition-colors">copy</button>
                      </div>
                      <pre className="px-3 py-3 text-[11px] font-mono text-white/70 overflow-x-auto whitespace-pre-wrap leading-5">{pySnippet}</pre>
                    </div>
                  )}
                  {lang === 'node' && (
                    <div className="bg-ink rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                        <span className="text-[10px] font-mono text-white/40">Node.js / node-fetch</span>
                        <button onClick={() => copy(nodeSnippet, 'Snippet copied')}
                          className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2.5 py-1 rounded transition-colors">copy</button>
                      </div>
                      <pre className="px-3 py-3 text-[11px] font-mono text-white/70 overflow-x-auto whitespace-pre-wrap leading-5">{nodeSnippet}</pre>
                    </div>
                  )}
                  {lang === 'browser' && (
                    <div className="bg-ink rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                        <span className="text-[10px] font-mono text-white/40">Browser extension</span>
                        <button onClick={() => copy(browserSnippet, 'Snippet copied')}
                          className="text-[10px] font-mono text-accent hover:opacity-70 border border-accent/30 px-2.5 py-1 rounded transition-colors">copy</button>
                      </div>
                      <pre className="px-3 py-3 text-[11px] font-mono text-white/70 overflow-x-auto whitespace-pre-wrap leading-5">{browserSnippet}</pre>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Delete */}
          <div className="flex items-center justify-between pt-3 mt-1 border-t border-border">
            <div className="text-[11px] text-muted font-mono">
              {!canDelete ? '⚠ Allocated by reseller — cannot delete' : 'Deleting returns allocated GB to your account'}
            </div>
            {canDelete && (
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
      )}
    </div>
  )
}
