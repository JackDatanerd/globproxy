'use client'
import { useEffect, useState } from 'react'
import { apiFetch, apiJson, toastApiError } from '@/lib/clientApi'
import toast from 'react-hot-toast'
import clsx from 'clsx'

interface WhitelistedIp {
  ip: string
  description: string
}

interface Props {
  credentialId: string
}

// The upstream provider's API has always had a full set of endpoints for
// locking a sub-user's credential down to specific source IPs
// (list/add/bulk-add/bulk-remove/remove-by-ip) — this is the first UI
// GlobProxy has exposed for it. With no whitelist entries, a credential's
// only access control is its username/password pair; adding IPs here
// restricts connections to just those sources on top of that.
//
// COPY NOTE: the user-facing text below used to claim listed IPs are the ONLY
// sources that can authenticate and that an empty list "accepts connections
// from any IP". Neither was ever verified against the provider's real behaviour —
// a provider whitelist can just as easily mean "these IPs may connect without
// credentials" as "only these IPs may connect". It now says only what is
// certain. Verify with a live test (connect from a non-listed IP with valid
// credentials) before describing this as an access restriction.
export default function IpWhitelist({ credentialId }: Props) {
  const [ips, setIps] = useState<WhitelistedIp[] | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [ip, setIp] = useState('')
  const [description, setDescription] = useState('')
  const [adding, setAdding] = useState(false)
  const [detectingIp, setDetectingIp] = useState(false)

  const [bulkMode, setBulkMode] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkAdding, setBulkAdding] = useState(false)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [removing, setRemoving] = useState<Set<string>>(new Set())
  const [bulkRemoving, setBulkRemoving] = useState(false)

  async function load() {
    try {
      const data = await apiFetch(`/api/dashboard/proxies/${credentialId}/whitelist`)
      setIps(data.ips ?? [])
      setProvisioning(!!data.provisioning)
      setLoadError(null)
    } catch (err: any) {
      setLoadError(err.message || 'Failed to load whitelist')
    }
  }

  useEffect(() => { setIps(null); setLoadError(null); setSelected(new Set()); load() }, [credentialId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fillMyIp() {
    setDetectingIp(true)
    try {
      const data = await apiFetch('/api/dashboard/my-ip')
      setIp(data.ip)
      if (!description.trim()) setDescription(`My IP (${new Date().toLocaleDateString()})`)
    } catch (err: any) {
      toastApiError(err)
    } finally {
      setDetectingIp(false)
    }
  }

  async function addIp(e: React.FormEvent) {
    e.preventDefault()
    if (!ip.trim()) { toast.error('Enter an IP address'); return }
    if (!description.trim()) { toast.error('Enter a short description (e.g. "Office IP")'); return }
    setAdding(true)
    try {
      const data = await apiJson('POST', `/api/dashboard/proxies/${credentialId}/whitelist`, { ip: ip.trim(), description: description.trim() })
      setIps(data.ips)
      setIp('')
      setDescription('')
      toast.success('IP whitelisted')
    } catch (err: any) {
      toastApiError(err)
    } finally {
      setAdding(false)
    }
  }

  // Accepts one entry per line, as "ip" or "ip,description" or
  // "ip description" — blank descriptions fall back to a timestamped
  // default rather than failing the whole batch over a missing label.
  // Comma is checked first (so a description containing spaces, e.g.
  // "<ip>, Office VPN exit", still splits correctly); falls back
  // to splitting on the first run of whitespace when there's no comma.
  function parseBulkLines(text: string): { ip: string; description: string }[] {
    const fallbackDesc = `Bulk added ${new Date().toLocaleDateString()}`
    return text
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(line => {
        let ipPart: string
        let desc: string
        if (line.includes(',')) {
          const idx = line.indexOf(',')
          ipPart = line.slice(0, idx).trim()
          desc = line.slice(idx + 1).trim()
        } else {
          const idx = line.search(/\s/)
          ipPart = idx === -1 ? line : line.slice(0, idx).trim()
          desc = idx === -1 ? '' : line.slice(idx + 1).trim()
        }
        return { ip: ipPart, description: desc || fallbackDesc }
      })
  }

  async function bulkAdd() {
    const items = parseBulkLines(bulkText)
    if (items.length === 0) { toast.error('Paste at least one IP'); return }
    if (items.length > 150) { toast.error('Max 150 IPs per bulk request'); return }
    const tooLong = items.findIndex(i => i.description.length > 100)
    if (tooLong !== -1) { toast.error(`Line ${tooLong + 1}: the description is over 100 characters — shorten it and try again.`); return }
    const before = ips?.length ?? 0
    setBulkAdding(true)
    try {
      const data = await apiJson('POST', `/api/dashboard/proxies/${credentialId}/whitelist/bulk`, { items })
      setIps(data.ips)
      setBulkText('')
      setBulkMode(false)
      // Report what actually landed — duplicates of existing entries are
      // not new, and "N submitted" overstated it.
      const added = Math.max(0, (data.ips?.length ?? 0) - before)
      toast.success(added === items.length
        ? `${added} IP${added === 1 ? '' : 's'} added`
        : `${added} new IP${added === 1 ? '' : 's'} added (${items.length - added} already on the list or merged)`)
    } catch (err: any) {
      toastApiError(err)
    } finally {
      setBulkAdding(false)
    }
  }

  async function removeIp(target: string) {
    setRemoving(prev => new Set(prev).add(target))
    try {
      const data = await apiFetch(
        `/api/dashboard/proxies/${credentialId}/whitelist?ip=${encodeURIComponent(target)}`,
        { method: 'DELETE' }
      )
      setIps(data.ips)
      setSelected(prev => { const n = new Set(prev); n.delete(target); return n })
      toast.success('IP removed')
    } catch (err: any) {
      toastApiError(err)
    } finally {
      setRemoving(prev => { const n = new Set(prev); n.delete(target); return n })
    }
  }

  async function removeSelected() {
    if (selected.size === 0) return
    const count = selected.size
    setBulkRemoving(true)
    try {
      // The route caps one request at 150 IPs; "select all" on a longer list used to be refused outright.
      const all = Array.from(selected)
      for (let i = 0; i < all.length; i += 150) {
        const data = await apiJson('DELETE', `/api/dashboard/proxies/${credentialId}/whitelist/bulk`, { ips: all.slice(i, i + 150) })
        setIps(data.ips)
      }
      toast.success(`${count} IP${count > 1 ? 's' : ''} removed`)
      setSelected(new Set())
    } catch (err: any) {
      toastApiError(err)
    } finally {
      setBulkRemoving(false)
    }
  }

  function toggleSelected(target: string) {
    setSelected(prev => {
      const n = new Set(prev)
      if (n.has(target)) n.delete(target); else n.add(target)
      return n
    })
  }

  function toggleSelectAll() {
    if (!ips || ips.length === 0) return
    setSelected(prev => prev.size === ips.length ? new Set() : new Set(ips.map(i => i.ip)))
  }

  if (ips === null) {
    return loadError
      ? <div className="text-xs text-red-500 px-3 py-3 font-mono">{loadError}{' '}<button onClick={load} className="underline hover:opacity-70">Retry</button></div>
      : <div className="text-xs text-muted px-3 py-3 font-mono">Loading whitelist...</div>
  }

  return (
    <div className="mb-2">
      {provisioning && (
        <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 font-mono">
          ⏳ This credential is still being provisioned — IP whitelisting will be available once it's active.
        </div>
      )}

      <p className="text-[10.5px] text-muted mb-3">
        IPs listed here are registered as authorized sources for this credential. Keep the username and
        password private regardless — don't rely on this list alone to keep other IPs out.
      </p>

      {/* Add form */}
      {!provisioning && (
        <div className="mb-3">
          {!bulkMode ? (
            <form onSubmit={addIp} className="flex flex-wrap gap-2">
              <input
                value={ip} onChange={e => setIp(e.target.value)}
                placeholder="Your public IP"
                className="flex-1 min-w-[140px] bg-white border border-border px-3 py-2 rounded-lg text-xs font-mono focus:outline-none focus:border-accent transition-colors"
              />
              <input
                value={description} onChange={e => setDescription(e.target.value)}
                placeholder="Description (e.g. Office IP)"
                maxLength={100}
                className="flex-1 min-w-[140px] bg-white border border-border px-3 py-2 rounded-lg text-xs focus:outline-none focus:border-accent transition-colors"
              />
              <button type="submit" disabled={adding}
                className="bg-accent text-white px-4 py-2 rounded-lg text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex-shrink-0">
                {adding ? 'Adding…' : 'Add IP'}
              </button>
              <button type="button" onClick={fillMyIp} disabled={detectingIp}
                className="text-[10.5px] font-mono text-accent hover:opacity-70 disabled:opacity-50 basis-full text-left">
                {detectingIp ? 'detecting…' : '↳ use my current IP'}
              </button>
            </form>
          ) : (
            <div>
              <textarea
                value={bulkText} onChange={e => setBulkText(e.target.value)}
                placeholder={'One per line: IP, description\n(public IPs only — not 192.168.x or 10.x)'}
                rows={4}
                className="w-full bg-white border border-border px-3 py-2 rounded-lg text-xs font-mono focus:outline-none focus:border-accent transition-colors resize-y"
              />
              <div className="flex gap-2 mt-2">
                <button type="button" onClick={bulkAdd} disabled={bulkAdding}
                  className="bg-accent text-white px-4 py-2 rounded-lg text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
                  {bulkAdding ? 'Adding…' : 'Add all'}
                </button>
              </div>
            </div>
          )}
          <button type="button" onClick={() => setBulkMode(v => !v)}
            className="text-[10.5px] font-mono text-muted hover:text-accent mt-1.5 transition-colors">
            {bulkMode ? '← back to single add' : 'bulk add multiple IPs →'}
          </button>
        </div>
      )}

      {/* List */}
      <div className="bg-ink rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
          <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
            Whitelisted IPs {ips.length > 0 ? `(${ips.length})` : ''}
          </span>
          {selected.size > 0 && (
            <button onClick={removeSelected} disabled={bulkRemoving}
              className="text-[10px] font-mono text-red-400 hover:opacity-70 border border-red-400/30 px-2.5 py-1 rounded transition-colors disabled:opacity-50">
              {bulkRemoving ? 'removing…' : `remove ${selected.size} selected`}
            </button>
          )}
        </div>

        {ips.length === 0 ? (
          <div className="px-3 py-4 text-[11px] font-mono text-white/40">
            No IPs whitelisted.
          </div>
        ) : (
          <div className="divide-y divide-white/10">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white/[0.02]">
              <input type="checkbox"
                checked={ips.length > 0 && selected.size === ips.length}
                onChange={toggleSelectAll}
                className="accent-accent" />
              <span className="text-[10px] font-mono text-white/30 uppercase tracking-wider">select all</span>
            </div>
            {ips.map(entry => (
              <div key={entry.ip} className="flex items-center gap-2 px-3 py-2.5">
                <input type="checkbox"
                  checked={selected.has(entry.ip)}
                  onChange={() => toggleSelected(entry.ip)}
                  className="accent-accent flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs text-white/80 truncate">{entry.ip}</div>
                  <div className="font-mono text-[10.5px] text-white/40 truncate">{entry.description}</div>
                </div>
                <button
                  onClick={() => removeIp(entry.ip)}
                  disabled={removing.has(entry.ip)}
                  title="Remove"
                  className={clsx(
                    'text-[10px] font-mono px-1.5 flex-shrink-0 transition-colors',
                    removing.has(entry.ip) ? 'text-white/20' : 'text-white/40 hover:text-red-400'
                  )}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
