'use client'
import { useState, useMemo, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { buildProxyUsername, getProxyPort, deriveSessionId } from '@/lib/proxyEndpoint'
import { apiJson, copyText } from '@/lib/clientApi'
import { formatGb, formatPct } from '@/lib/format'
import SessionManager from '@/components/dashboard/SessionManager'
import IpWhitelist from '@/components/dashboard/IpWhitelist'
import CredentialSettings from '@/components/dashboard/CredentialSettings'
import toast from 'react-hot-toast'
import clsx from 'clsx'

interface Props {
  cred: any
  index: number
  // Unallocated GB on the account — what a manual top-up draws from.
  availableGb?: number
  expanded: boolean
  onToggle: () => void
  // Server flag (PASSWORD_ROTATION_ENABLED): shows "Rotate password" only
  // where the backend will actually do it.
  rotationEnabled?: boolean
  // Lets the list jump straight to a tab (the near-limit banner opens
  // Bandwidth). `nonce` changes on every request so asking for the same tab
  // twice still works after the user has clicked elsewhere.
  requestedTab?: { tab: 'cred' | 'bandwidth' | 'endpoints' | 'whitelist' | 'code'; nonce: number } | null
}

// One pair of thresholds for every indicator on the card (rail, bar, tab dot,
// remaining text) and for the list's banners. They used to disagree — the rail
// went red at 85 while the bar went red at 80 and the banner said 95.
const WARN_PCT = 80
const URGENT_PCT = 95

type Tab = 'cred' | 'bandwidth' | 'endpoints' | 'whitelist' | 'edit' | 'code'
type Lang = 'py' | 'node' | 'browser'

// Row-based redesign: collapsed by default (status communicated by the left
// rail, not by reading text), expands to the same credential/endpoint/code
// detail the old always-open card showed, just organized into tabs so the
// expanded state doesn't turn into another giant scroll once someone has a
// handful of sessions.
export default function ProxyCard({ cred, index, availableGb, expanded, onToggle, requestedTab, rotationEnabled }: Props) {
  const router = useRouter()
  const [showPass, setShowPass] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [tab, setTab] = useState<Tab>('cred')
  const [lang, setLang] = useState<Lang>('py')
  const [justCopied, setJustCopied] = useState(false)

  // Manual top-up
  const [topupAmount, setTopupAmount] = useState('')
  const [topupLoading, setTopupLoading] = useState(false)

  // Auto-allocate — seeded from the credential row and re-seeded (effect
  // below) when the saved values change, i.e. after router.refresh() hands
  // down fresh server data. useState's initial value only runs once, so
  // without the effect a change made from another tab/device never showed.
  const [autoEnabled, setAutoEnabled] = useState(!!cred.auto_topup_enabled)
  const [autoThreshold, setAutoThreshold] = useState(String(cred.auto_topup_threshold_gb ?? ''))
  const [autoAmount, setAutoAmount] = useState(String(cred.auto_topup_amount_gb ?? ''))
  const [autoLoading, setAutoLoading] = useState(false)
  // Pending credentials: on-demand "retry provisioning"
  const [retrying, setRetrying] = useState(false)
  // Hand unused GB back to the account balance
  const [releaseAmount, setReleaseAmount] = useState('')
  const [releasing, setReleasing] = useState(false)
  // Password rotation (two-click confirm, disarms itself like delete)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [rotating, setRotating] = useState(false)
  useEffect(() => {
    if (!confirmRotate) return
    const t = setTimeout(() => setConfirmRotate(false), 4000)
    return () => clearTimeout(t)
  }, [confirmRotate])
  useEffect(() => {
    setAutoEnabled(!!cred.auto_topup_enabled)
    setAutoThreshold(String(cred.auto_topup_threshold_gb ?? ''))
    setAutoAmount(String(cred.auto_topup_amount_gb ?? ''))
  }, [cred.auto_topup_enabled, cred.auto_topup_threshold_gb, cred.auto_topup_amount_gb])

  useEffect(() => {
    if (requestedTab) setTab(requestedTab.tab)
  }, [requestedTab?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // An armed "Confirm delete" must not outlive the moment: disarm after a few
  // seconds and whenever the row is collapsed, so a stray click later (or on
  // re-opening the row) can't delete a session in one tap.
  useEffect(() => {
    if (!confirmDelete) return
    const t = setTimeout(() => setConfirmDelete(false), 4000)
    return () => clearTimeout(t)
  }, [confirmDelete])
  useEffect(() => { if (!expanded) setConfirmDelete(false) }, [expanded])

  const host = cred.host || 'proxy.globproxy.com'
  const port = cred.port || getProxyPort(cred.protocol, cred.session_type)
  const baseUser = cred.username || '—'
  const pass = cred.password || '—'
  const gbAllocated = cred.gb_allocated || 0
  const gbUsed = cred.gb_used || 0
  const pct = gbAllocated > 0 ? (gbUsed / gbAllocated) * 100 : 0

  // Re-evaluated on a timer while inside the 10-minute window: computed once
  // per render it stayed on "warming up" until something else re-rendered the
  // card, long after the credentials were live.
  const [nowMs, setNowMs] = useState(() => Date.now())
  const warmEndsAt = cred.activated_at ? new Date(cred.activated_at).getTime() + 10 * 60 * 1000 : 0
  useEffect(() => {
    if (!warmEndsAt || Date.now() >= warmEndsAt) return
    const t = setInterval(() => {
      const n = Date.now()
      setNowMs(n)
      if (n >= warmEndsAt) clearInterval(t)
    }, 15_000)
    return () => clearInterval(t)
  }, [warmEndsAt])
  const isWarmingUp = !!cred.activated_at && nowMs < warmEndsAt

  const isSticky = cred.session_type === 'sticky'
  const isSocks5 = cred.protocol === 'socks5'
  // The server refuses delete / edit / top-up / release on ANY reseller-
  // allocated session (created_by set), including one whose creator is the
  // owner — mirror that exactly instead of showing buttons that return 403.
  const canDelete = !cred.created_by
  const canEdit = canDelete
  // What a release can hand back: unused GB minus the safety margin the
  // server keeps (it re-checks against live usage, this is just the hint).
  const unusedGb = Math.max(0, gbAllocated - gbUsed)
  const releasableGb = Math.max(0, Math.floor((unusedGb - 0.06) * 100) / 100)

  // A rotating username carries no session id (buildProxyUsername only adds
  // one for sticky), so endpoint_count > 1 used to render N byte-identical
  // lines and "copy all" pasted the same endpoint N times. One rotating
  // endpoint already serves any number of connections, each on a fresh IP —
  // show it once.
  const rotatingUser = buildProxyUsername(baseUser, { ...cred, session_type: 'rotating', sticky_duration: null })
  const endpoints: string[] = isSticky ? [] : [`${host}:${port}:${rotatingUser}:${pass}`]

  // Ad hoc sticky endpoint for the header's quick-copy button. The
  // managed, persisted sessions (SessionManager, "Sticky sessions" tab)
  // are the real management surface, but the same on-the-fly pattern
  // already used for rotating endpoints above works just as well here —
  // stickiness lives in the connection username itself (the
  // lifetime/session suffix), not in anything that has to be pre-registered
  // in our DB. Without this, sticky sessions had no quick-copy at all
  // (endpoints was always [] for them), unlike every rotating session.
  // Derived from the credential id, NOT random: a random id per mount moved
  // the sticky session to a different IP on every page load, and made any
  // endpoint the customer had already copied stale immediately. Named
  // sessions (SessionManager) are the explicit way to get a fresh IP.
  const quickStickySessionId = useMemo(() => deriveSessionId(cred.id, 0), [cred.id])
  // The username everything on the card shows and every snippet embeds. For a
  // sticky session this MUST carry the lifetime/session suffix (the sticky
  // port with a bare username is not a sticky connection, and the chosen
  // duration would never apply); rotating sessions use the bare form.
  const stickyUser = isSticky ? buildProxyUsername(baseUser, cred, quickStickySessionId) : null
  const user = stickyUser ?? rotatingUser
  const quickStickyEndpoint = stickyUser ? `${host}:${port}:${stickyUser}:${pass}` : null

  async function copy(text: string, label = 'Copied') {
    if (await copyText(text)) toast.success(label)
    else toast.error('Couldn\u2019t access the clipboard — select the text and copy it manually.')
  }

  function copyAll() {
    copy(endpoints.join('\n'), 'Endpoint copied')
  }

  async function quickCopy(e: React.MouseEvent) {
    e.stopPropagation()
    const target = isSticky ? quickStickyEndpoint : endpoints[0]
    if (!target) return
    if (!(await copyText(target))) { toast.error('Couldn\u2019t access the clipboard.'); return }
    setJustCopied(true)
    toast.success('Endpoint copied')
    setTimeout(() => setJustCopied(false), 1300)
  }

  function downloadTxt() {
    const name = cred.label || `proxy-session-${index + 1}`
    const blob = new Blob([endpoints.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    // Labels are free text — keep the download name filesystem-safe.
    const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'proxy-session'
    a.href = url; a.download = `${safe}.txt`
    // Attached while clicked and revoked later: revoking in the same tick can
    // cancel the download in Safari/Firefox, and a detached anchor's click is
    // ignored by some of them.
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    toast.success('Downloaded')
  }

  // Pause keeps the allocation, credentials and settings but stops the session
  // from using bandwidth (same mechanism as an admin kill); resume restores it.
  // Only a pause the customer made can be undone here — one set by GlobProxy
  // can't (the server answers 403 and says to contact support).
  async function togglePause(resume: boolean) {
    if (pausing) return
    setPausing(true)
    try {
      await apiJson('POST', `/api/dashboard/proxies/${cred.id}/${resume ? 'resume' : 'pause'}`)
      toast.success(resume ? 'Session resumed' : 'Session paused — it won’t use bandwidth until you resume it')
      router.refresh()
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err.message ?? (resume ? 'Could not resume' : 'Could not pause'))
    } finally {
      setPausing(false)
    }
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    try {
      const res = await apiJson<{ gb_released?: number; gb_used?: number }>('DELETE', `/api/dashboard/proxies/${cred.id}`)
      const released = Number(res?.gb_released ?? 0)
      toast.success(released >= 0.01
        ? `Session deleted — ${formatGb(released)} GB returned to your balance`
        : 'Session deleted')
      router.refresh()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setDeleting(false); setConfirmDelete(false)
    }
  }

  async function handleTopup(e: React.FormEvent) {
    e.preventDefault()
    const gb = Number(topupAmount)
    if (!Number.isFinite(gb) || gb <= 0) { toast.error('Enter a GB amount greater than 0'); return }
    if (availableGb !== undefined && gb > availableGb + 0.005) {
      toast.error(`You only have ${formatGb(availableGb)} GB unallocated — buy more bandwidth or free some from another session.`)
      return
    }
    setTopupLoading(true)
    try {
      const data = await apiJson('POST', `/api/dashboard/proxies/${cred.id}/topup`, { gb_amount: gb })
      toast.success(`+${formatGb(gb)} GB added`)
      if (data.warning) toast(data.warning, { icon: '⚠️', duration: 6000 })
      setTopupAmount('')
      router.refresh()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setTopupLoading(false)
    }
  }

  async function handleRelease(e: React.FormEvent) {
    e.preventDefault()
    const gb = Number(releaseAmount)
    if (!Number.isFinite(gb) || gb < 0.01) { toast.error('Enter at least 0.01 GB'); return }
    if (gb > releasableGb + 0.0001) {
      toast.error(releasableGb >= 0.01
        ? `Only ${formatGb(releasableGb)} GB can be released right now — the rest is used or kept as a safety margin.`
        : 'This session has no unused bandwidth that can be released right now.')
      return
    }
    setReleasing(true)
    try {
      const data = await apiJson('POST', `/api/dashboard/proxies/${cred.id}/release`, { gb_amount: gb })
      toast.success(`${formatGb(gb)} GB returned to your balance`)
      if (data.warning) toast(data.warning, { icon: '⚠️', duration: 6000 })
      setReleaseAmount('')
      router.refresh()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setReleasing(false)
    }
  }

  async function handleRotatePassword() {
    if (!confirmRotate) { setConfirmRotate(true); return }
    setRotating(true)
    try {
      await apiJson('POST', `/api/dashboard/proxies/${cred.id}/rotate-password`)
      toast.success('Password changed — update it anywhere this session is in use')
      setShowPass(true)
      router.refresh()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setRotating(false); setConfirmRotate(false)
    }
  }

  async function handleRetryProvisioning(e: React.MouseEvent) {
    e.stopPropagation()
    setRetrying(true)
    try {
      await apiJson('POST', `/api/dashboard/proxies/${cred.id}/retry`)
      toast.success('Session is now active')
      router.refresh()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setRetrying(false)
    }
  }

  async function handleAutoTopupSave(e: React.FormEvent) {
    e.preventDefault()
    if (autoEnabled) {
      const t = Number(autoThreshold), a = Number(autoAmount)
      if (!Number.isFinite(t) || t < 0) { toast.error('Threshold must be 0 or greater'); return }
      if (!Number.isFinite(a) || a <= 0) { toast.error('Top-up amount must be greater than 0'); return }
      if (a <= t) { toast.error('The amount added must be larger than the threshold, or it would re-trigger immediately.'); return }
    }
    setAutoLoading(true)
    try {
      await apiJson('PATCH', `/api/dashboard/proxies/${cred.id}/auto-topup`, {
        enabled: autoEnabled,
        threshold_gb: autoEnabled ? Number(autoThreshold) : null,
        amount_gb: autoEnabled ? Number(autoAmount) : null,
      })
      toast.success(autoEnabled ? 'Auto-allocate enabled' : 'Auto-allocate disabled')
      router.refresh()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setAutoLoading(false)
    }
  }

  // socks5h (not socks5): resolve DNS on the proxy side, matching the Python
  // and Node snippets and avoiding DNS leaks from the user's own resolver.
  const verifyCurl = `curl -x ${isSocks5 ? 'socks5h' : 'http'}://${user}:${pass}@${host}:${port} https://ipinfo.io/json`

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

  // CommonJS + node-fetch@2: the old snippet mixed require() with a top-level
  // await, which Node refuses to run ("both require() and top-level await are
  // present"), and node-fetch v3 is ESM-only so require() would fail anyway.
  const nodeSnippet = isSocks5 ? `// npm install socks-proxy-agent node-fetch@2
const { SocksProxyAgent } = require("socks-proxy-agent");
const fetch = require("node-fetch");

const agent = new SocksProxyAgent(
  "socks5h://${user}:${pass}@${host}:${port}"
);

(async () => {
  const res = await fetch("https://ipinfo.io/json", { agent });
  console.log(await res.json()); // shows proxy IP and location
})();` : `// npm install https-proxy-agent node-fetch@2
const { HttpsProxyAgent } = require("https-proxy-agent");
const fetch = require("node-fetch");

const agent = new HttpsProxyAgent(
  "http://${user}:${pass}@${host}:${port}"
);

(async () => {
  const res = await fetch("https://ipinfo.io/json", { agent });
  console.log(await res.json()); // shows proxy IP and location
})();`

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
    : cred.status === 'active' && isWarmingUp ? 'bg-accent'
    : cred.status === 'suspended' ? 'bg-red-300'
    : cred.status === 'active' && pct >= URGENT_PCT ? 'bg-red-400'
    : cred.status === 'active' && pct >= WARN_PCT ? 'bg-amber-400'
    : cred.status === 'active' ? 'bg-accent2'
    : 'bg-border'

  const usageFillColor = pct >= URGENT_PCT ? 'bg-red-400' : pct >= WARN_PCT ? 'bg-amber-400' : 'bg-accent2'

  const statusBadge = cred.status === 'active'
    ? 'text-accent2 bg-accent2-light'
    : cred.status === 'pending'
    ? 'text-amber-600 bg-amber-50'
    : 'text-muted bg-surface border border-border'

  return (
    <div className={clsx('relative bg-white border rounded-xl overflow-hidden transition-colors', expanded ? 'border-accent/30' : 'border-border hover:border-ink2/20')}>
      <div className={clsx('absolute left-0 top-0 bottom-0 w-[3px] rounded-l-xl', railColor)} />

      {/* Collapsed row header — click to expand */}
      {/* The row is clickable for mouse users, but the keyboard/screen-reader
          control is the real <button> around the title block — a role="button"
          container holding another button (quick copy) is invalid ARIA. */}
      <div
        onClick={onToggle}
        className="flex items-center gap-4 pl-6 pr-4 py-3.5 cursor-pointer select-none rounded-xl">
        <button type="button" onClick={e => { e.stopPropagation(); onToggle() }} aria-expanded={expanded}
          aria-label={`${cred.label || `Session #${index + 1}`} — ${expanded ? 'collapse' : 'expand'} details`}
          className="flex-1 min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-md">
          <span className="flex items-center gap-2 flex-wrap w-full">
            <span className="text-sm font-medium text-ink truncate">{cred.label || `Session #${index + 1}`}</span>
            <span className={clsx('text-[9px] font-mono px-2 py-0.5 rounded-full uppercase tracking-wide', statusBadge)}>{cred.status}</span>
            {isWarmingUp && cred.status === 'active' && (
              <span className="text-[9px] font-mono px-2 py-0.5 rounded-full uppercase tracking-wide text-accent bg-accent-light">warming up</span>
            )}
            {cred.created_by && (
              <span className="text-[9px] font-mono px-2 py-0.5 rounded-full uppercase tracking-wide text-muted bg-surface border border-border">via reseller</span>
            )}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] font-mono text-muted mt-0.5 w-full">
            <span>{cred.session_type}</span><span>·</span><span>{(cred.protocol || 'http').toUpperCase()}</span>
            {isSticky && cred.sticky_duration && <><span>·</span><span>{cred.sticky_duration}min sticky</span></>}
            {(cred.country || cred.city) && <><span>·</span><span>{[cred.city, cred.country].filter(Boolean).join(', ')}</span></>}
          </span>
        </button>

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

        {cred.status === 'active' && (isSticky ? !!quickStickyEndpoint : endpoints.length > 0) && (
          <button onClick={quickCopy} title={isSticky ? 'Quick copy a sticky endpoint' : 'Quick copy endpoint'}
            aria-label={isSticky ? 'Quick copy a sticky endpoint' : 'Quick copy endpoint'}
            className={clsx(
              'w-8 h-8 rounded-lg border flex items-center justify-center transition-colors flex-shrink-0',
              justCopied ? 'border-accent2 text-accent2 bg-accent2-light' : 'border-border text-ink2 hover:border-accent hover:text-accent hover:bg-accent-light'
            )}>
            {justCopied ? '✓' : '⧉'}
          </button>
        )}

        <span aria-hidden="true" className={clsx('text-muted transition-transform flex-shrink-0', expanded && 'rotate-90')}>▶</span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border px-6 pb-5 pt-4">
          {cred.status === 'pending' && (
            <div className="mb-4 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 font-mono">
              <div>
                {cred.pending_reason === 'capacity'
                  ? '⏳ This session is queued: we’re adding network capacity right now. It will activate automatically as soon as capacity is available, and your bandwidth is already reserved.'
                  : '⏳ This session is queued: the proxy network was unreachable when it was created. We retry automatically, and your bandwidth is already reserved.'}
              </div>
              {cred.provision_stalled_at && (
                <div className="mt-1.5 text-amber-800">
                  This is taking longer than usual. We’ve been alerted and emailed you — nothing is lost, and you can also delete this session to return its bandwidth to your balance.
                </div>
              )}
              <button onClick={handleRetryProvisioning} disabled={retrying}
                className="mt-2 border border-amber-300 text-amber-800 px-3 py-1.5 rounded-lg text-[11px] hover:bg-amber-100 disabled:opacity-60 transition-colors">
                {retrying ? 'Retrying…' : 'Retry now'}
              </button>
            </div>
          )}
          {cred.status === 'suspended' && (
            <div className="mb-4 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-4 py-3 font-mono">
              <div>
                {cred.suspended_reason === 'customer'
                  ? '⏸ You paused this session. It keeps its bandwidth and settings but won’t connect until you resume it.'
                  : cred.suspended_reason === 'account'
                  ? '⏸ This session is paused because your account is suspended. It comes back when the account is reinstated — nothing has been lost.'
                  : cred.suspended_reason === 'admin'
                    ? '⏸ This session was disabled by our team. Your bandwidth is safe and nothing has been deducted, but it won’t connect until we re-enable it.'
                    : '⏸ This session is currently disabled and won’t connect. Your bandwidth is safe.'}
              </div>
              {cred.suspended_reason === 'customer' && canDelete && (
                <button onClick={() => togglePause(true)} disabled={pausing}
                  className="mt-2 bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs disabled:opacity-60 hover:opacity-90">
                  {pausing ? 'Resuming…' : 'Resume session'}
                </button>
              )}
              <div className="mt-1.5">
                Think this is a mistake? <Link href="/dashboard/support" className="underline hover:opacity-80">Contact support</Link> and quote “{cred.label || cred.id.slice(0, 8)}”.
              </div>
            </div>
          )}
          {cred.status === 'active' && cred.upstream_missing_since && (
            <div className="mb-4 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-4 py-3 font-mono">
              ⚠ This session isn’t responding on our network right now. We’ve been alerted and are fixing it — your bandwidth is safe. If it’s still down after a while, contact support.
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
              <div role="tablist" aria-label="Session details"
                onKeyDown={e => {
                  // Standard tab pattern: arrows move between tabs, Home/End jump.
                  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
                  if (!keys.includes(e.key)) return
                  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
                  const i = tabs.findIndex(t => t === document.activeElement)
                  if (i === -1) return
                  e.preventDefault()
                  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
                    : e.key === 'ArrowRight' ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length
                  tabs[next].focus(); tabs[next].click()
                }}
                className="flex items-center gap-5 border-b border-border mb-4 overflow-x-auto">
                <button role="tab" aria-selected={tab === 'cred'} tabIndex={tab === 'cred' ? 0 : -1} onClick={() => setTab('cred')}
                  className={clsx('text-xs font-mono pb-2 -mb-px border-b-2 transition-colors', tab === 'cred' ? 'text-ink border-accent font-medium' : 'text-muted border-transparent hover:text-ink')}>
                  Credentials
                </button>
                <button role="tab" aria-selected={tab === 'bandwidth'} tabIndex={tab === 'bandwidth' ? 0 : -1} onClick={() => setTab('bandwidth')}
                  className={clsx('text-xs font-mono pb-2 -mb-px border-b-2 transition-colors', tab === 'bandwidth' ? 'text-ink border-accent font-medium' : 'text-muted border-transparent hover:text-ink')}>
                  Bandwidth{pct >= WARN_PCT && <span className={clsx('ml-1', pct >= URGENT_PCT ? 'text-red-400' : 'text-amber-400')}>●</span>}
                </button>
                <button role="tab" aria-selected={tab === 'endpoints'} tabIndex={tab === 'endpoints' ? 0 : -1} onClick={() => setTab('endpoints')}
                  className={clsx('text-xs font-mono pb-2 -mb-px border-b-2 transition-colors', tab === 'endpoints' ? 'text-ink border-accent font-medium' : 'text-muted border-transparent hover:text-ink')}>
                  {isSticky ? 'Sticky sessions' : 'Endpoint'}
                </button>
                <button role="tab" aria-selected={tab === 'whitelist'} tabIndex={tab === 'whitelist' ? 0 : -1} onClick={() => setTab('whitelist')}
                  className={clsx('text-xs font-mono pb-2 -mb-px border-b-2 transition-colors', tab === 'whitelist' ? 'text-ink border-accent font-medium' : 'text-muted border-transparent hover:text-ink')}>
                  IP whitelist
                </button>
                {canEdit && (
                  <button role="tab" aria-selected={tab === 'edit'} tabIndex={tab === 'edit' ? 0 : -1} onClick={() => setTab('edit')}
                    className={clsx('text-xs font-mono pb-2 -mb-px border-b-2 transition-colors', tab === 'edit' ? 'text-ink border-accent font-medium' : 'text-muted border-transparent hover:text-ink')}>
                    Edit
                  </button>
                )}
                <button role="tab" aria-selected={tab === 'code'} tabIndex={tab === 'code' ? 0 : -1} onClick={() => setTab('code')}
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
              {tab === 'cred' && rotationEnabled && canEdit && (
                <div className="flex items-center justify-between gap-3 mb-2">
                  <p className="text-[10.5px] text-muted">
                    Think the password leaked? Rotating gives this session a new one — the old one stops working immediately.
                  </p>
                  <button onClick={handleRotatePassword} disabled={rotating}
                    className={clsx(
                      'text-[11px] font-mono px-3 py-1.5 rounded-lg border transition-all flex-shrink-0 disabled:opacity-50',
                      confirmRotate ? 'bg-red-500 text-white border-red-500 hover:opacity-90' : 'border-border text-muted hover:border-accent hover:text-accent'
                    )}>
                    {rotating ? 'Rotating…' : confirmRotate ? 'Confirm rotate' : 'Rotate password'}
                  </button>
                </div>
              )}
              {tab === 'cred' && isSticky && (
                <p className="text-[10.5px] text-muted mb-2">
                  Sticky username: the <span className="font-mono">-lifetime-…-session-…</span> part keeps your exit IP for the
                  chosen duration. This one is a ready-made example; open <strong>Sticky sessions</strong> to create named
                  sessions, each with its own IP.
                </p>
              )}

              {tab === 'bandwidth' && (
                <div className="mb-2">
                  {!canDelete ? (
                    <div className="text-xs text-muted bg-surface border border-border rounded-lg px-4 py-3 font-mono">
                      ⚠ This session was allocated by your reseller. Bandwidth top-ups and auto-allocate aren't available here — contact them directly.
                    </div>
                  ) : (
                    <>
                      <div className="bg-surface border border-border rounded-lg px-4 py-3 mb-2 flex items-center justify-between">
                        <span className="text-[10px] font-mono text-muted uppercase tracking-wider">Remaining</span>
                        <span className={clsx('text-sm font-mono font-medium', pct >= URGENT_PCT ? 'text-red-500' : pct >= WARN_PCT ? 'text-amber-600' : 'text-ink')}>
                          {formatGb(Math.max(0, gbAllocated - gbUsed))} GB of {formatGb(gbAllocated)} GB
                        </span>
                      </div>

                      {/* Manual top-up */}
                      <form onSubmit={handleTopup} className="mb-4">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="text-[10px] font-mono text-muted uppercase tracking-widest">Top up now</div>
                          {availableGb !== undefined && (
                            <button type="button" disabled={availableGb <= 0}
                              onClick={() => setTopupAmount(String(Math.floor(availableGb * 100) / 100))}
                              className="text-[10px] font-mono text-accent hover:opacity-70 disabled:opacity-40 disabled:no-underline">
                              {formatGb(availableGb)} GB available · use all
                            </button>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="number" inputMode="decimal" min="0.01" step="any" placeholder="GB to add"
                            value={topupAmount} onChange={e => setTopupAmount(e.target.value)}
                            className="flex-1 bg-white border border-border px-3 py-2 rounded-lg text-xs focus:outline-none focus:border-accent transition-colors"
                          />
                          <button type="submit" disabled={topupLoading}
                            className="bg-accent text-white px-4 py-2 rounded-lg text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex-shrink-0">
                            {topupLoading ? 'Adding…' : 'Add GB'}
                          </button>
                        </div>
                        <p className="text-[10.5px] text-muted mt-1.5">
                          {availableGb !== undefined && availableGb <= 0
                            ? 'Your account has no unallocated bandwidth left — buy more to top this session up.'
                            : 'Draws from your unallocated account balance and applies immediately — no new session needed.'}
                        </p>
                      </form>

                      {/* Release unused GB back to the account balance */}
                      <form onSubmit={handleRelease} className="mb-4 border-t border-border pt-4">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="text-[10px] font-mono text-muted uppercase tracking-widest">Release unused GB</div>
                          <button type="button" disabled={releasableGb < 0.01}
                            onClick={() => setReleaseAmount(String(releasableGb))}
                            className="text-[10px] font-mono text-accent hover:opacity-70 disabled:opacity-40">
                            {formatGb(releasableGb)} GB releasable · use max
                          </button>
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="number" inputMode="decimal" min="0.01" step="any" placeholder="GB to release"
                            value={releaseAmount} onChange={e => setReleaseAmount(e.target.value)}
                            className="flex-1 bg-white border border-border px-3 py-2 rounded-lg text-xs focus:outline-none focus:border-accent transition-colors"
                          />
                          <button type="submit" disabled={releasing || releasableGb < 0.01}
                            className="border border-border text-ink2 px-4 py-2 rounded-lg text-xs font-medium hover:border-accent hover:text-accent transition-colors disabled:opacity-50 flex-shrink-0">
                            {releasing ? 'Releasing…' : 'Release GB'}
                          </button>
                        </div>
                        <p className="text-[10.5px] text-muted mt-1.5">
                          Moves bandwidth this session hasn’t used back to your account balance, so you can give it to another session — without deleting this one. A small safety margin always stays.
                        </p>
                      </form>

                      {/* Auto-allocate */}
                      <form onSubmit={handleAutoTopupSave} className="border-t border-border pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <div>
                            <div className="text-xs font-medium text-ink">Auto-allocate</div>
                            <p className="text-[10.5px] text-muted mt-0.5">
                              Automatically top up this session before it runs out.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setAutoEnabled(v => !v)}
                            aria-pressed={autoEnabled}
                            className={clsx('relative w-9 h-5 rounded-full transition-colors flex-shrink-0', autoEnabled ? 'bg-accent' : 'bg-border')}
                          >
                            <span className={clsx('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform', autoEnabled && 'translate-x-4')} />
                          </button>
                        </div>

                        {autoEnabled && (
                          <div className="flex gap-2 mb-2">
                            <div className="flex-1">
                              <label className="text-[10px] font-mono text-muted uppercase tracking-wider block mb-1">When remaining falls below</label>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number" inputMode="decimal" min="0" step="any" placeholder="e.g. 2"
                                  value={autoThreshold} onChange={e => setAutoThreshold(e.target.value)}
                                  className="w-full bg-white border border-border px-3 py-2 rounded-lg text-xs focus:outline-none focus:border-accent transition-colors"
                                />
                                <span className="text-[10.5px] text-muted flex-shrink-0">GB</span>
                              </div>
                            </div>
                            <div className="flex-1">
                              <label className="text-[10px] font-mono text-muted uppercase tracking-wider block mb-1">Add</label>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number" inputMode="decimal" min="0.01" step="any" placeholder="e.g. 10"
                                  value={autoAmount} onChange={e => setAutoAmount(e.target.value)}
                                  className="w-full bg-white border border-border px-3 py-2 rounded-lg text-xs focus:outline-none focus:border-accent transition-colors"
                                />
                                <span className="text-[10.5px] text-muted flex-shrink-0">GB</span>
                              </div>
                            </div>
                          </div>
                        )}

                        <button type="submit" disabled={autoLoading}
                          className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-accent hover:text-accent transition-colors disabled:opacity-50">
                          {autoLoading ? 'Saving…' : 'Save auto-allocate settings'}
                        </button>
                        {autoEnabled && cred.auto_topup_insufficient_alerted_at && (
                          <p className="text-[10.5px] text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mt-2 font-mono">
                            ⚠ Auto-allocate couldn’t fully top this session up — your account balance is empty or too low. Buy more bandwidth and it will resume on its own.
                          </p>
                        )}
                        {autoEnabled && (
                          <p className="text-[10.5px] text-muted mt-1.5">
                            Checked roughly every 5 minutes. If your balance can't cover the full amount it tops up with whatever is available, and emails you if there's nothing left — the session keeps working off its current allocation meanwhile.
                          </p>
                        )}
                      </form>
                    </>
                  )}
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
                  <div className="mb-2">
                  <p className="text-[11px] text-muted mb-2">
                    Rotating session — every request exits through a new IP. This one endpoint handles any number of connections; there&apos;s no need for more.
                  </p>
                  <div className="bg-ink rounded-lg overflow-hidden">
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
                  </div>
                )
              )}

              {tab === 'whitelist' && (
                <IpWhitelist credentialId={cred.id} />
              )}

              {tab === 'edit' && (
                // key forces a fresh form when a refreshed `cred` arrives after a save
                <CredentialSettings key={`${cred.id}:${cred.label}:${cred.country}:${cred.state}:${cred.city}:${cred.asn}:${cred.protocol}:${cred.session_type}:${cred.sticky_duration}`} cred={cred} />
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
              {!canDelete ? '⚠ Allocated by reseller — cannot delete' : 'Deleting returns this session\u2019s unused GB to your account — GB already used isn\u2019t refunded'}
            </div>
            <div className="flex items-center flex-shrink-0">
            {canDelete && cred.status === 'active' && (
              <button onClick={() => togglePause(false)} disabled={pausing || deleting}
                title="Stop this session using bandwidth without deleting it. Resume any time."
                className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-muted hover:border-amber-300 hover:text-amber-600 transition-all disabled:opacity-50 mr-2">
                {pausing ? 'Pausing…' : 'Pause'}
              </button>
            )}
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
        </div>
      )}
    </div>
  )
}
