'use client'
import { useState, useMemo, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { apiJson } from '@/lib/clientApi'
import { formatGb } from '@/lib/format'
import {
  fetchCountryList, fetchCountryDetail, POPULAR_COUNTRY_CODES,
  type CountryListItem, type CountryDetail,
} from '@/lib/geoTargeting'
import { buildProxyUsername, getProxyPort, validateTargeting } from '@/lib/proxyEndpoint'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import AsnPicker from '@/components/dashboard/AsnPicker'
import NumberField from '@/components/dashboard/NumberField'

const STICKY_DURATIONS = [
  { value: 1,    label: '1 min' },
  { value: 10,   label: '10 min' },
  { value: 30,   label: '30 min' },
  { value: 60,   label: '1 hour' },
  { value: 360,  label: '6 hours' },
  { value: 720,  label: '12 hours' },
  { value: 1440, label: '24 hours' }, // confirmed max from live dashboard ("Rotating Interval: 24 Hour")
]

type DefaultAutoTopup = { enabled: boolean; threshold_gb: number | null; amount_gb: number | null }

export default function NewProxyForm({ availableGb, defaultAutoTopup }: { availableGb: number; defaultAutoTopup?: DefaultAutoTopup }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Seeds the auto-allocate fields from the account-level default (set on
  // the Settings page) so it doesn't have to be re-entered on every new
  // session — still fully editable below before submitting, and a plain
  // 1/5 fallback when there's no default configured yet.
  const [form, setForm] = useState({
    label:           '',
    country:         '',
    state:           '',
    city:            '',
    asn:             '',
    protocol:        'http' as 'http' | 'socks5',
    session_type:    'rotating' as 'rotating' | 'sticky',
    sticky_duration: 10,
    // Never start over budget: an account with under 1 GB free used to open the form with the red "exceeds your balance" warning.
    gb_allocated:    availableGb > 0 && availableGb < 1 ? (Math.floor(availableGb * 100) / 100 || availableGb) : 1,
    auto_topup_enabled:      defaultAutoTopup?.enabled ?? false,
    auto_topup_threshold_gb: defaultAutoTopup?.threshold_gb ?? 1,
    auto_topup_amount_gb:    defaultAutoTopup?.amount_gb ?? 5,
  })
  // Only relevant when auto-allocate is on for this session — lets someone
  // update their account-level default from right here instead of having
  // to go find it on the Settings page.
  const [saveAsDefault, setSaveAsDefault] = useState(false)

  function set(k: string, v: any) { setForm(f => ({ ...f, [k]: v })) }

  // Geo picker data — country list loads once on mount; the state/city
  // tree for whichever country is selected loads on demand (see
  // lib/geoTargeting.ts). Both are backed by the network's real supported
  // locations, not hand-typed text, so a selection here can never end up
  // being something the network doesn't recognize.
  const [countryList, setCountryList] = useState<CountryListItem[]>([])
  const [countryListError, setCountryListError] = useState<string | null>(null)
  const [countryDetail, setCountryDetail] = useState<CountryDetail | null>(null)
  const [geoLoading, setGeoLoading] = useState(false)
  const [geoError, setGeoError] = useState<string | null>(null)

  useEffect(() => {
    fetchCountryList()
      .then(setCountryList)
      .catch(e => setCountryListError(e.message))
  }, [])

  // Latest country the customer picked. fetchCountryDetail has no
  // cancellation, so switching A → B quickly could let A's late response
  // overwrite B's regions/cities (and the form would then accept a region that
  // belongs to the wrong country). Only the response for the current pick counts.
  const countryReq = useRef('')
  function setCountry(v: string) {
    countryReq.current = v
    setForm(f => ({ ...f, country: v, state: '', city: '' }))
    setCountryDetail(null)
    setGeoError(null)
    if (!v) { setGeoLoading(false); return }
    setGeoLoading(true)
    fetchCountryDetail(v)
      .then(d => { if (countryReq.current === v) setCountryDetail(d) })
      .catch(e => { if (countryReq.current === v) setGeoError(e.message) })
      .finally(() => { if (countryReq.current === v) setGeoLoading(false) })
  }

  function setState(v: string) {
    setForm(f => ({ ...f, state: v, city: '' }))
  }

  const selectedStateOption = countryDetail?.states.find(s => s.code === form.state) ?? null
  const selectedCountryName = countryList.find(c => c.code === form.country)?.name ?? ''
  const selectedCityName = selectedStateOption?.cities.find(c => c.code === form.city)?.name ?? ''

  // Custom sticky lifetime (the API accepts any 1–1440 minutes; the pills only
  // cover the common ones). Active when chosen explicitly or when the current
  // value isn't one of the pills.
  const [customDuration, setCustomDuration] = useState(false)
  const customDurationActive = customDuration || !STICKY_DURATIONS.some(d => d.value === form.sticky_duration)

  // Live endpoint preview — uses the same builder as ProxyCard and the v1
  // API, so this preview can never drift out of sync with what the customer
  // actually gets.
  const previewUsername = useMemo(
    () => buildProxyUsername('gp_xxxxxxxx', form, 'xxxxxxxx'),
    [form.country, form.state, form.city, form.asn, form.session_type, form.sticky_duration]
  )

  const previewPort = getProxyPort(form.protocol, form.session_type)
  const previewProto = form.protocol === 'socks5' ? 'socks5' : 'http'
  const previewLine = `${previewProto}://${previewUsername}:••••••••@proxy.globproxy.com:${previewPort}`

  // Tolerance of half a cent of a GB: "use all" and typed values go through
  // floats, and a balance like 4.999999999 must not read as over budget.
  const overBudget = form.gb_allocated > availableGb + 0.005
  const gbLeftAfter = Math.max(0, availableGb - (form.gb_allocated || 0))
  const gbMeterPct = availableGb > 0 ? Math.min(100, ((form.gb_allocated || 0) / availableGb) * 100) : 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!Number.isFinite(form.gb_allocated) || form.gb_allocated < 0.01) {
      toast.error('Enter at least 0.01 GB to allocate')
      return
    }
    if (overBudget) {
      toast.error(`You only have ${formatGb(availableGb)} GB available`)
      return
    }
    const targetingError = validateTargeting(form)
    if (targetingError) {
      toast.error(targetingError)
      return
    }
    if (form.auto_topup_enabled) {
      if (!Number.isFinite(form.auto_topup_threshold_gb) || form.auto_topup_threshold_gb < 0) {
        toast.error('Auto-allocate threshold must be 0 or greater')
        return
      }
      if (!Number.isFinite(form.auto_topup_amount_gb) || form.auto_topup_amount_gb <= 0) {
        toast.error('Auto-allocate top-up amount must be greater than 0')
        return
      }
      if (form.auto_topup_amount_gb <= form.auto_topup_threshold_gb) {
        toast.error('The auto-allocate amount must be larger than the threshold, or it would re-trigger immediately.')
        return
      }
    }
    setLoading(true)
    try {
      // Only the fields the server uses. sticky_duration is meaningless on a
      // rotating session (it used to be sent — and stored — anyway), and
      // endpoint_count is always 1: a rotating username carries no session id,
      // so extra "endpoints" were identical strings.
      const data = await apiJson('POST', '/api/dashboard/proxies', {
        label: form.label.trim() || undefined,
        country: form.country || undefined,
        state: form.state || undefined,
        city: form.city || undefined,
        asn: form.asn || undefined,
        protocol: form.protocol,
        session_type: form.session_type,
        ...(form.session_type === 'sticky' ? { sticky_duration: form.sticky_duration } : {}),
        endpoint_count: 1,
        gb_allocated: form.gb_allocated,
        auto_topup_enabled: form.auto_topup_enabled,
        auto_topup_threshold_gb: form.auto_topup_enabled ? form.auto_topup_threshold_gb : undefined,
        auto_topup_amount_gb: form.auto_topup_enabled ? form.auto_topup_amount_gb : undefined,
      })
      toast.success('Proxy session created!')
      if (data.warning) toast(data.warning, { icon: '⚠️', duration: 6000 })

      // Optional, non-fatal: update the account-level default so future
      // sessions pre-fill with these same numbers. Failing this shouldn't
      // block navigating away from a session that was already created
      // successfully — it's just a convenience setting for next time.
      if (saveAsDefault) {
        await apiJson('PATCH', '/api/dashboard/settings/auto-topup-default', {
          enabled: form.auto_topup_enabled,
          threshold_gb: form.auto_topup_enabled ? form.auto_topup_threshold_gb : null,
          amount_gb: form.auto_topup_enabled ? form.auto_topup_amount_gb : null,
        }).catch((e) => {
          // fetch only rejects on network failure, so a 4xx from the route
          // (e.g. validation) used to vanish without a trace.
          console.error('Failed to save auto-allocate default', e)
          toast(`Session created, but your default wasn\u2019t saved: ${e?.message ?? 'unknown error'}`, { icon: '⚠️', duration: 6000 })
        })
      }

      router.push('/dashboard/proxies')
      router.refresh()
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="text-xs font-mono text-muted mb-3.5 flex items-center gap-1.5">
        <button type="button" onClick={() => router.push('/dashboard/proxies')} className="hover:text-accent transition-colors">My Proxies</button>
        <span>/</span>
        <span className="text-ink">New session</span>
      </div>

      <div className="mb-6">
        <h1 className="font-display font-bold text-2xl text-ink">New proxy session</h1>
        <p className="text-muted text-sm mt-1">
          Configure your proxy — <span className="text-accent font-medium">{formatGb(availableGb)} GB</span> available to allocate.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 items-start">

        {/* ============ FORM: one continuous card, numbered sections ============ */}
        <div className="bg-white border border-border rounded-2xl overflow-hidden">

          {/* 1. Label */}
          <div className="px-7 py-6 border-b border-border">
            <div className="flex items-baseline justify-between mb-3.5">
              <div className="font-display font-semibold text-[15px] text-ink flex items-center gap-2">
                <span className="font-mono text-[10px] text-muted border border-border rounded-md w-5 h-5 inline-flex items-center justify-center">1</span>
                Label
              </div>
              <span className="text-[10.5px] font-mono text-muted">optional</span>
            </div>
            <input value={form.label} onChange={e => set('label', e.target.value)}
              placeholder="e.g. US Scraper, UK Account Manager"
              className="w-full bg-surface border border-border px-3.5 py-2.5 rounded-lg text-[13.5px] focus:outline-none focus:border-accent transition-colors" />
          </div>

          {/* 2. Location */}
          <div className="px-7 py-6 border-b border-border">
            <div className="font-display font-semibold text-[15px] text-ink flex items-center gap-2 mb-3.5">
              <span className="font-mono text-[10px] text-muted border border-border rounded-md w-5 h-5 inline-flex items-center justify-center">2</span>
              Location
            </div>

            <label className="block text-xs text-ink2 font-medium mb-1.5">Country</label>
            <select value={form.country} onChange={e => setCountry(e.target.value)}
              className="w-full bg-surface border border-border px-3.5 py-2.5 rounded-lg text-[13.5px] focus:outline-none focus:border-accent transition-colors">
              <option value="">Any country</option>
              {countryList.some(c => POPULAR_COUNTRY_CODES.has(c.code)) && (
                <optgroup label="Popular">
                  {countryList.filter(c => POPULAR_COUNTRY_CODES.has(c.code)).map(c => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label="All countries">
                {countryList.filter(c => !POPULAR_COUNTRY_CODES.has(c.code)).map(c => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </optgroup>
            </select>
            {countryListError && (
              <p className="text-xs text-red-600 mt-1">Couldn't load the country list — {countryListError}. Try refreshing the page.</p>
            )}

            <div className="grid grid-cols-2 gap-3 mt-3.5">
              <div>
                <label className="block text-xs text-ink2 font-medium mb-1.5">State / Region <span className="text-muted font-normal">(optional)</span></label>
                <select value={form.state} onChange={e => setState(e.target.value)}
                  disabled={!form.country || geoLoading || !countryDetail || countryDetail.states.length === 0}
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  <option value="">Any</option>
                  {countryDetail?.states.map(s => (
                    <option key={s.code} value={s.code}>{s.name}</option>
                  ))}
                </select>
                {!form.country && <p className="text-xs text-muted mt-1">Pick a country first</p>}
                {form.country && geoLoading && <p className="text-xs text-muted mt-1">Loading regions…</p>}
                {form.country && !geoLoading && countryDetail && countryDetail.states.length === 0 && (
                  <p className="text-xs text-muted mt-1">No region-level targeting available for this country</p>
                )}
                {geoError && <p className="text-xs text-red-600 mt-1">Couldn't load regions — {geoError}</p>}
              </div>
              <div>
                <label className="block text-xs text-ink2 font-medium mb-1.5">City <span className="text-muted font-normal">(optional)</span></label>
                <select value={form.city} onChange={e => set('city', e.target.value)}
                  disabled={!form.state || !selectedStateOption}
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  <option value="">Any</option>
                  {selectedStateOption?.cities.map(c => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </select>
                {!form.state && <p className="text-xs text-muted mt-1">Pick a region first</p>}
              </div>
            </div>

            {/* Advanced targeting — moved behind a disclosure since ASN is
                used by a minority of sessions and was previously sharing
                equal visual weight with country/state/city. */}
            <button type="button" onClick={() => setAdvancedOpen(o => !o)}
              className="flex items-center gap-1.5 text-xs font-mono text-accent mt-3.5">
              <span className={clsx('inline-block transition-transform text-[10px]', advancedOpen && 'rotate-90')}>▶</span>
              Advanced targeting (ASN / ISP)
            </button>
            {advancedOpen && (
              <div className="mt-3">
                <label className="block text-xs text-ink2 font-medium mb-1.5">ASN / ISP <span className="text-muted font-normal">(optional)</span></label>
                <AsnPicker
                  country={form.country} value={form.asn} onChange={v => set('asn', v)}
                  className="w-full bg-surface border border-border px-3.5 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors" />
                <p className="text-xs text-muted mt-1.5">Target a specific ISP. Pick a country first and you can search that country&apos;s ISPs by name or number; an ISP that doesn&apos;t exist in the chosen country is rejected rather than creating a session that can&apos;t connect.</p>
              </div>
            )}
          </div>

          {/* 3. Protocol & session type */}
          <div className="px-7 py-6 border-b border-border">
            <div className="font-display font-semibold text-[15px] text-ink flex items-center gap-2 mb-3.5">
              <span className="font-mono text-[10px] text-muted border border-border rounded-md w-5 h-5 inline-flex items-center justify-center">3</span>
              Protocol &amp; session type
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {(['http', 'socks5'] as const).map(val => (
                <button type="button" key={val} onClick={() => set('protocol', val)}
                  className={clsx('p-3.5 rounded-xl border-[1.5px] text-left transition-all', form.protocol === val ? 'border-accent bg-accent-light' : 'border-border hover:border-accent/40')}>
                  <div className="font-medium text-[13.5px] text-ink">{val === 'socks5' ? 'SOCKS5' : 'HTTP / HTTPS'}</div>
                  <div className="text-[11.5px] font-mono text-muted mt-0.5">Port {getProxyPort(val, form.session_type)}</div>
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2.5 mt-2.5">
              {([['rotating', 'Rotating', 'New IP per request'], ['sticky', 'Sticky', 'Same IP per session']] as const).map(([val, label, sub]) => (
                <button type="button" key={val} onClick={() => set('session_type', val)}
                  className={clsx('p-3.5 rounded-xl border-[1.5px] text-left transition-all', form.session_type === val ? 'border-accent bg-accent-light' : 'border-border hover:border-accent/40')}>
                  <div className="font-medium text-[13.5px] text-ink">{label}</div>
                  <div className="text-[11.5px] font-mono text-muted mt-0.5">{sub}</div>
                </button>
              ))}
            </div>

            {form.session_type === 'sticky' && (
              <div className="mt-3.5">
                <label className="block text-xs text-ink2 font-medium mb-1.5">Sticky duration</label>
                <div className="flex gap-1.5 flex-wrap">
                  {STICKY_DURATIONS.map(d => (
                    <button type="button" key={d.value} onClick={() => { setCustomDuration(false); set('sticky_duration', d.value) }}
                      className={clsx('px-3.5 py-1.5 rounded-full border text-[11.5px] font-mono transition-all', form.sticky_duration === d.value ? 'border-accent bg-accent-light text-accent' : 'border-border text-ink2 hover:border-accent/40')}>
                      {d.label}
                    </button>
                  ))}
                  <button type="button" onClick={() => setCustomDuration(true)}
                    className={clsx('px-3.5 py-1.5 rounded-full border text-[11.5px] font-mono transition-all', customDurationActive ? 'border-accent bg-accent-light text-accent' : 'border-border text-ink2 hover:border-accent/40')}>
                    Custom
                  </button>
                </div>
                {customDurationActive && (
                  <div className="flex items-center gap-2 mt-2.5">
                    <input type="number" inputMode="numeric" min={1} max={1440} step={1}
                      value={form.sticky_duration}
                      onChange={e => {
                        const n = Math.round(Number(e.target.value))
                        set('sticky_duration', Number.isFinite(n) ? Math.min(1440, Math.max(1, n)) : 1)
                      }}
                      className="w-28 bg-surface border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors" />
                    <span className="text-xs text-muted">minutes (1–1440)</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 4. Sizing */}
          <div className="px-7 py-6">
            <div className="font-display font-semibold text-[15px] text-ink flex items-center gap-2 mb-3.5">
              <span className="font-mono text-[10px] text-muted border border-border rounded-md w-5 h-5 inline-flex items-center justify-center">4</span>
              Sizing
            </div>
            <div className="grid grid-cols-1 gap-3.5">
              <div>
                <label className="block text-xs text-ink2 font-medium mb-1.5">
                  GB to allocate
                  <button type="button" onClick={() => {
                      // Round DOWN to 2dp so the box shows exactly what is
                      // reserved (no float dust like 4.999999999), unless that
                      // would leave nothing.
                      const down = Math.floor(availableGb * 100) / 100
                      set('gb_allocated', down > 0 ? down : availableGb)
                    }}
                    className="ml-2 text-[10px] font-mono text-accent bg-accent-light px-2 py-0.5 rounded hover:opacity-80 transition-opacity align-middle">
                    use all
                  </button>
                </label>
                <div className="relative">
                  <NumberField required min={0.01}
                    value={form.gb_allocated}
                    onValue={n => set('gb_allocated', n)}
                    className="w-full bg-surface border border-border px-3.5 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors pr-11" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11.5px] font-mono text-muted pointer-events-none">GB</span>
                </div>
                <p className="text-xs text-muted mt-1.5">
                  {formatGb(availableGb)} GB available. {form.session_type === 'rotating'
                    ? 'One rotating endpoint serves any number of connections.'
                    : 'You can create named sticky sessions after this is set up.'}
                </p>
              </div>
            </div>
          </div>

          {/* 5. Auto-allocate */}
          <div className="px-7 py-6 border-t border-border">
            <div className="flex items-center justify-between mb-1">
              <div className="font-display font-semibold text-[15px] text-ink flex items-center gap-2">
                <span className="font-mono text-[10px] text-muted border border-border rounded-md w-5 h-5 inline-flex items-center justify-center">5</span>
                Auto-allocate
              </div>
              <button
                type="button"
                onClick={() => set('auto_topup_enabled', !form.auto_topup_enabled)}
                aria-pressed={form.auto_topup_enabled}
                className={clsx('relative w-9 h-5 rounded-full transition-colors flex-shrink-0', form.auto_topup_enabled ? 'bg-accent' : 'bg-border')}
              >
                <span className={clsx('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform', form.auto_topup_enabled && 'translate-x-4')} />
              </button>
            </div>
            <p className="text-xs text-muted mb-3.5">
              Automatically top up this session from your account balance before it runs out — no need to create a new one when it depletes.
            </p>

            {form.auto_topup_enabled && (
              <div className="grid grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs text-ink2 font-medium mb-1.5">When remaining falls below</label>
                  <div className="relative">
                    <NumberField min={0}
                      value={form.auto_topup_threshold_gb}
                      onValue={n => set('auto_topup_threshold_gb', n)}
                      className="w-full bg-surface border border-border px-3.5 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors pr-11" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11.5px] font-mono text-muted pointer-events-none">GB</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-ink2 font-medium mb-1.5">Add</label>
                  <div className="relative">
                    <NumberField min={0.01}
                      value={form.auto_topup_amount_gb}
                      onValue={n => set('auto_topup_amount_gb', n)}
                      className="w-full bg-surface border border-border px-3.5 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors pr-11" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11.5px] font-mono text-muted pointer-events-none">GB</span>
                  </div>
                </div>
                <p className="col-span-2 text-xs text-muted -mt-1">
                  Checked roughly every 5 minutes. If your balance can't cover a top-up, you'll get an email instead of it failing silently.
                </p>
                <label className="col-span-2 flex items-center gap-2 -mt-0.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={saveAsDefault}
                    onChange={e => setSaveAsDefault(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-accent"
                  />
                  <span className="text-xs text-ink2">Use these numbers as my default for future sessions</span>
                </label>
              </div>
            )}
          </div>
        </div>

        {/* ============ RECEIPT: sticky live summary + submit ============ */}
        <div className="lg:sticky lg:top-6">
          <div className="bg-ink rounded-2xl overflow-hidden text-white shadow-[0_12px_32px_rgba(15,17,20,.18)]">
            <div className="px-6 pt-5 pb-4 border-b border-dashed border-white/[.14]">
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">Session preview</div>
              <div className="font-display font-semibold text-[17px]">{form.label || 'Untitled session'}</div>
            </div>

            <div className="px-6 py-4">
              <div className="flex justify-between items-center py-2 text-[12.5px]">
                <span className="font-mono text-[10.5px] uppercase tracking-wide text-white/45">Location</span>
                <span className="font-medium text-white/90 text-right">
                  {form.country ? [selectedCityName, selectedCountryName].filter(Boolean).join(', ') : 'Any location'}
                </span>
              </div>
              <div className="flex justify-between items-center py-2 text-[12.5px]">
                <span className="font-mono text-[10.5px] uppercase tracking-wide text-white/45">Protocol</span>
                <span className="font-medium text-white/90">{form.protocol === 'socks5' ? 'SOCKS5' : 'HTTP / HTTPS'}</span>
              </div>
              <div className="flex justify-between items-center py-2 text-[12.5px]">
                <span className="font-mono text-[10.5px] uppercase tracking-wide text-white/45">Type</span>
                <span className="font-medium text-white/90">
                  {form.session_type === 'sticky'
                    ? `Sticky · ${form.sticky_duration >= 60 ? (form.sticky_duration / 60) + 'hr' : form.sticky_duration + 'min'}`
                    : 'Rotating'}
                </span>
              </div>
              <div className="flex justify-between items-center py-2 text-[12.5px]">
                <span className="font-mono text-[10.5px] uppercase tracking-wide text-white/45">Auto-allocate</span>
                <span className="font-medium text-white/90">
                  {form.auto_topup_enabled
                    ? `Below ${Number.isFinite(form.auto_topup_threshold_gb) ? form.auto_topup_threshold_gb : 0} GB → +${Number.isFinite(form.auto_topup_amount_gb) ? form.auto_topup_amount_gb : 0} GB`
                    : 'Off'}
                </span>
              </div>

              <div className="bg-white/[.06] border border-white/10 rounded-lg px-3.5 py-3 my-3.5 font-mono text-[11px] text-white/75 break-all leading-relaxed">
                <span className="block text-[9.5px] uppercase tracking-widest text-white/35 mb-1.5">Endpoint</span>
                {previewLine}
              </div>

              <div className="mt-4 mb-1.5">
                <div className="h-1.5 bg-white/[.12] rounded-full overflow-hidden">
                  <div className={clsx('h-full rounded-full transition-all', overBudget ? 'bg-red-400' : 'bg-accent2')}
                    style={{ width: `${gbMeterPct}%` }} />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-white/45 mt-1.5">
                  <span>{formatGb(form.gb_allocated)} GB allocated</span>
                  <span>{formatGb(gbLeftAfter)} GB left after</span>
                </div>
              </div>

              {overBudget && (
                <div className="flex gap-1.5 items-start text-[11px] text-amber-400 bg-amber-400/[.14] px-2.5 py-2 rounded-lg mt-2.5 leading-relaxed">
                  ⚠ <span>This exceeds your available balance.</span>
                </div>
              )}
            </div>

            <div className="px-6 pb-6 pt-1">
              <button type="submit" disabled={loading || overBudget || (form.gb_allocated || 0) <= 0}
                className="w-full bg-accent2 text-ink py-3 rounded-xl text-[13.5px] font-semibold hover:brightness-105 hover:-translate-y-0.5 disabled:opacity-40 disabled:hover:translate-y-0 transition-all">
                {loading ? 'Creating session…' : `Create session — ${formatGb(form.gb_allocated)} GB`}
              </button>
              <button type="button" onClick={() => router.push('/dashboard/proxies')}
                className="w-full text-center mt-2.5 text-xs text-white/40 hover:text-white/70 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>

      </form>
    </div>
  )
}
