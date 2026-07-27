'use client'
import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { POPULAR_COUNTRIES, OTHER_COUNTRIES } from '@/lib/countries'
import { POPULAR_US_STATES, OTHER_US_STATES } from '@/lib/usStates'
import { buildProxyUsername, getProxyPort } from '@/lib/proxyEndpoint'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const STICKY_DURATIONS = [
  { value: 1,    label: '1 min' },
  { value: 10,   label: '10 min' },
  { value: 30,   label: '30 min' },
  { value: 60,   label: '1 hour' },
  { value: 360,  label: '6 hours' },
  { value: 720,  label: '12 hours' },
  { value: 1440, label: '24 hours' }, // confirmed max from live dashboard ("Rotating Interval: 24 Hour")
]

export default function NewProxyForm({ availableGb }: { availableGb: number }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    label:           '',
    country:         '',
    state:           '',
    city:            '',
    asn:             '',
    protocol:        'http' as 'http' | 'socks5',
    session_type:    'rotating' as 'rotating' | 'sticky',
    sticky_duration: 10,
    endpoint_count:  1,
    gb_allocated:    1,
  })

  function set(k: string, v: any) { setForm(f => ({ ...f, [k]: v })) }

  // Live endpoint preview — uses the same builder as ProxyCard and the v1
  // API, so this preview can never drift out of sync with what the customer
  // actually gets again. Previously this was hand-rolled here with three
  // separate bugs: uppercase country (Geonode wants lowercase), no
  // "-type-residential" segment, and a fake hardcoded "-session-1" with no
  // real lifetime value.
  const previewUsername = useMemo(
    () => buildProxyUsername('gp_xxxxxxxx', form, 'xxxxxxxx'),
    [form.country, form.state, form.city, form.asn, form.session_type, form.sticky_duration]
  )

  const previewPort = getProxyPort(form.protocol, form.session_type)
  const previewProto = form.protocol === 'socks5' ? 'socks5' : 'http'
  const previewLine = `${previewProto}://${previewUsername}:••••••••@proxy.globproxy.com:${previewPort}`

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (form.gb_allocated > availableGb) {
      toast.error(`You only have ${availableGb.toFixed(2)}GB available`)
      return
    }
    setLoading(true)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/dashboard/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Proxy session created!')
      router.push('/dashboard/proxies')
      router.refresh()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">New proxy session</h1>
        <p className="text-muted text-sm mt-1">
          Configure your proxy. You have <span className="text-accent font-medium">{availableGb.toFixed(2)} GB</span> available.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">

        {/* Label */}
        <div className="bg-white border border-border rounded-xl p-5">
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Session label (optional)</label>
          <input value={form.label} onChange={e => set('label', e.target.value)}
            placeholder="e.g. US Scraper, UK Account Manager"
            className="w-full bg-surface border border-border px-4 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors" />
        </div>

        {/* Geo */}
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">Geo targeting</div>
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="block text-xs text-muted mb-1">Country</label>
              <select value={form.country} onChange={e => set('country', e.target.value)}
                className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors">
                <option value="">Any country</option>
                <optgroup label="Popular">
                  {POPULAR_COUNTRIES.map(c => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </optgroup>
                <optgroup label="All countries">
                  {OTHER_COUNTRIES.map(c => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-muted mb-1">State / Region <span className="text-muted">(optional)</span></label>
                {form.country === 'US' ? (
                  <select value={form.state} onChange={e => set('state', e.target.value)}
                    className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors">
                    <option value="">Any</option>
                    <optgroup label="Popular">
                      {POPULAR_US_STATES.map(s => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </optgroup>
                    <optgroup label="All states">
                      {OTHER_US_STATES.map(s => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </optgroup>
                  </select>
                ) : (
                  <input value={form.state} onChange={e => set('state', e.target.value)}
                    placeholder="e.g. england"
                    className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors" />
                )}
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">City <span className="text-muted">(optional)</span></label>
                <input value={form.city} onChange={e => set('city', e.target.value)}
                  placeholder="e.g. new york"
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors" />
              </div>
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">
                ASN / ISP targeting <span className="text-muted">(optional)</span>
              </label>
              <input value={form.asn} onChange={e => set('asn', e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="e.g. 13868"
                className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors" />
              <p className="text-xs text-muted mt-1">Target a specific ISP by ASN number — look yours up at a public ASN lookup tool (e.g. bgp.he.net) if you're not sure of the number.</p>
            </div>
          </div>
        </div>

        {/* Protocol */}
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">Protocol</div>
          <div className="flex gap-3">
            {(['http', 'socks5'] as const).map(val => (
              <button type="button" key={val} onClick={() => set('protocol', val)}
                className={clsx('flex-1 p-3.5 rounded-xl border-2 text-left transition-all', form.protocol === val ? 'border-accent bg-accent-light' : 'border-border hover:border-accent/40')}>
                <div className="font-medium text-sm text-ink">{val === 'socks5' ? 'SOCKS5' : 'HTTP / HTTPS'}</div>
                <div className="text-xs text-muted mt-0.5">Port {getProxyPort(val, form.session_type)}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Session type */}
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">Session type</div>
          <div className="flex gap-3 mb-3">
            {([['rotating','Rotating','New IP per request'],['sticky','Sticky','Same IP per session']] as const).map(([val, label, sub]) => (
              <button type="button" key={val} onClick={() => set('session_type', val)}
                className={clsx('flex-1 p-3.5 rounded-xl border-2 text-left transition-all', form.session_type === val ? 'border-accent bg-accent-light' : 'border-border hover:border-accent/40')}>
                <div className="font-medium text-sm text-ink">{label}</div>
                <div className="text-xs text-muted mt-0.5">{sub}</div>
              </button>
            ))}
          </div>
          {form.session_type === 'sticky' && (
            <div>
              <label className="block text-xs text-muted mb-1.5">Sticky duration</label>
              <div className="flex gap-2">
                {STICKY_DURATIONS.map(d => (
                  <button type="button" key={d.value} onClick={() => set('sticky_duration', d.value)}
                    className={clsx('flex-1 py-2 rounded-lg border text-xs font-mono transition-all', form.sticky_duration === d.value ? 'border-accent bg-accent-light text-accent' : 'border-border text-muted hover:border-accent/40')}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Endpoints + GB */}
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Endpoints (1–10)</label>
              <input type="number" min={1} max={10} value={form.endpoint_count}
                onChange={e => set('endpoint_count', Math.min(10, Math.max(1, +e.target.value)))}
                className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors" />
              <p className="text-xs text-muted mt-1">Multiple endpoints for parallel connections</p>
            </div>
            <div>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">GB to allocate</label>
              <div className="relative">
                <input type="number" required min={0.01} step={0.01} max={availableGb}
                  value={form.gb_allocated}
                  onChange={e => set('gb_allocated', +e.target.value)}
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors pr-20" />
                <button type="button" onClick={() => set('gb_allocated', availableGb)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-accent bg-accent-light px-2 py-0.5 rounded hover:opacity-80 transition-opacity">
                  Use all
                </button>
              </div>
              <p className="text-xs text-muted mt-1">{availableGb.toFixed(2)} GB available</p>
            </div>
          </div>
        </div>

        {/* Live endpoint preview */}
        <div className="bg-ink rounded-xl p-4">
          <div className="text-[10px] font-mono text-white/40 uppercase tracking-widest mb-2">Live endpoint preview</div>
          <div className="font-mono text-sm text-white/80 break-all leading-relaxed">{previewLine}</div>
          {form.session_type === 'sticky' && form.endpoint_count > 1 && (
            <div className="mt-2 text-[11px] font-mono text-white/40">
              +{form.endpoint_count - 1} more endpoints, each with its own unique session ID
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button type="submit" disabled={loading || form.gb_allocated > availableGb}
            className="flex-1 bg-accent text-white py-3.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity shadow-[0_2px_8px_rgba(0,87,255,.2)]">
            {loading ? 'Creating session...' : `Create session — ${form.gb_allocated} GB`}
          </button>
          <button type="button" onClick={() => router.back()}
            className="border border-border text-muted px-5 py-3.5 rounded-xl text-sm hover:text-ink transition-colors">
            Cancel
          </button>
        </div>

      </form>
    </div>
  )
}
