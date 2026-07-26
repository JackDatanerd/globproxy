'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { buildProxyUsername, getProxyPort } from '@/lib/proxyEndpoint'
import { POPULAR_US_STATES, OTHER_US_STATES } from '@/lib/usStates'

const COUNTRIES = [
  { code: 'us', name: 'United States' },
  { code: 'gb', name: 'United Kingdom' },
  { code: 'ca', name: 'Canada' },
  { code: 'au', name: 'Australia' },
  { code: 'de', name: 'Germany' },
  { code: 'fr', name: 'France' },
  { code: 'jp', name: 'Japan' },
  { code: 'br', name: 'Brazil' },
  { code: 'in', name: 'India' },
  { code: 'it', name: 'Italy' },
  { code: 'es', name: 'Spain' },
  { code: 'nl', name: 'Netherlands' },
  { code: 'sg', name: 'Singapore' },
  { code: 'hk', name: 'Hong Kong' },
  { code: 'kr', name: 'South Korea' },
  { code: 'mx', name: 'Mexico' },
  { code: 'ru', name: 'Russia' },
  { code: 'pl', name: 'Poland' },
  { code: 'se', name: 'Sweden' },
  { code: 'no', name: 'Norway' },
  { code: 'fi', name: 'Finland' },
  { code: 'dk', name: 'Denmark' },
  { code: 'ch', name: 'Switzerland' },
  { code: 'at', name: 'Austria' },
  { code: 'be', name: 'Belgium' },
  { code: 'cz', name: 'Czech Republic' },
  { code: 'hu', name: 'Hungary' },
  { code: 'ro', name: 'Romania' },
  { code: 'pt', name: 'Portugal' },
  { code: 'gr', name: 'Greece' },
  { code: 'tr', name: 'Turkey' },
  { code: 'il', name: 'Israel' },
  { code: 'za', name: 'South Africa' },
  { code: 'ng', name: 'Nigeria' },
  { code: 'ke', name: 'Kenya' },
  { code: 'eg', name: 'Egypt' },
  { code: 'gh', name: 'Ghana' },
  { code: 'tz', name: 'Tanzania' },
  { code: 'ug', name: 'Uganda' },
  { code: 'ma', name: 'Morocco' },
  { code: 'ar', name: 'Argentina' },
  { code: 'cl', name: 'Chile' },
  { code: 'co', name: 'Colombia' },
  { code: 'pe', name: 'Peru' },
  { code: 'vn', name: 'Vietnam' },
  { code: 'th', name: 'Thailand' },
  { code: 'id', name: 'Indonesia' },
  { code: 'my', name: 'Malaysia' },
  { code: 'ph', name: 'Philippines' },
  { code: 'tw', name: 'Taiwan' },
  { code: 'nz', name: 'New Zealand' },
  { code: 'ie', name: 'Ireland' },
  { code: 'ua', name: 'Ukraine' },
  { code: 'bg', name: 'Bulgaria' },
  { code: 'hr', name: 'Croatia' },
  { code: 'rs', name: 'Serbia' },
  { code: 'sk', name: 'Slovakia' },
  { code: 'si', name: 'Slovenia' },
  { code: 'lt', name: 'Lithuania' },
  { code: 'lv', name: 'Latvia' },
  { code: 'ee', name: 'Estonia' },
  { code: 'ae', name: 'UAE' },
  { code: 'sa', name: 'Saudi Arabia' },
  { code: 'qa', name: 'Qatar' },
  { code: 'kw', name: 'Kuwait' },
  { code: 'jo', name: 'Jordan' },
]

export default function NewProxyForm({ availableGb }: { availableGb: number }) {
  const router = useRouter()

  const [label, setLabel] = useState('')
  const [country, setCountry] = useState('')
  const [state, setState] = useState('')
  const [city, setCity] = useState('')
  const [protocol, setProtocol] = useState<'http' | 'socks5'>('http')
  const [sessionType, setSessionType] = useState<'rotating' | 'sticky'>('rotating')
  const [stickyDuration, setStickyDuration] = useState(10)
  const [endpointCount, setEndpointCount] = useState(1)
  const [gbAllocated, setGbAllocated] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const port = getProxyPort(protocol, sessionType)
  const previewUser = buildProxyUsername('gp_xxxxxxxxxxxxxxxx', {
    country, state, city, session_type: sessionType, sticky_duration: stickyDuration,
  }, 'xxxxxxxx')
  const previewEndpoint = `proxy.globproxy.com:${port}:${previewUser}:••••••••••••••••`

  async function handleSubmit() {
    if (!gbAllocated || gbAllocated <= 0) { setError('GB amount must be greater than 0'); return }
    if (gbAllocated > availableGb) { setError('Not enough bandwidth available'); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/dashboard/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label || null,
          country: country || null,
          state: state || null,
          city: city || null,
          protocol,
          session_type: sessionType,
          sticky_duration: sessionType === 'sticky' ? stickyDuration : null,
          endpoint_count: endpointCount,
          gb_allocated: gbAllocated,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Something went wrong'); return }
      router.push('/dashboard/proxies')
      router.refresh()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">New proxy session</h1>
        <p className="text-muted text-sm mt-1">
          {availableGb.toFixed(1)} GB available ·{' '}
          <a href="/dashboard/buy" className="text-accent hover:underline">Buy more</a>
        </p>
      </div>

      {availableGb === 0 && (
        <div className="mb-6 bg-yellow-50 border border-yellow-100 text-yellow-700 text-sm rounded-xl px-4 py-3">
          You have no bandwidth available.{' '}
          <a href="/dashboard/buy" className="underline font-medium">Purchase bandwidth</a> to create a session.
        </div>
      )}

      <div className="bg-white border border-border rounded-xl divide-y divide-border">

        {/* Label */}
        <div className="p-5">
          <label className="block text-sm font-medium text-ink mb-2">
            Session name <span className="text-muted font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. US Scraper, Kenya Residential"
            className="w-full border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
          />
        </div>

        {/* Targeting */}
        <div className="p-5">
          <div className="text-sm font-medium text-ink mb-3">Location targeting</div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-muted mb-1.5">Country</label>
              <select
                value={country}
                onChange={e => setCountry(e.target.value)}
                className="w-full border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent bg-white"
              >
                <option value="">Any</option>
                {COUNTRIES.map(c => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted mb-1.5">State</label>
              {country === 'US' ? (
                <select
                  value={state}
                  onChange={e => setState(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent bg-white"
                >
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
                <input
                  type="text"
                  value={state}
                  onChange={e => setState(e.target.value)}
                  placeholder="e.g. england"
                  className="w-full border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
              )}
            </div>
            <div>
              <label className="block text-xs text-muted mb-1.5">City</label>
              <input
                type="text"
                value={city}
                onChange={e => setCity(e.target.value)}
                placeholder="e.g. los-angeles"
                className="w-full border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
              />
            </div>
          </div>
        </div>

        {/* Protocol */}
        <div className="p-5">
          <div className="text-sm font-medium text-ink mb-3">Protocol</div>
          <div className="flex gap-3">
            {(['http', 'socks5'] as const).map(p => (
              <button
                key={p}
                onClick={() => setProtocol(p)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-all ${
                  protocol === p
                    ? 'bg-accent text-white border-accent'
                    : 'bg-white text-ink border-border hover:border-accent/40'
                }`}
              >
                {p === 'http' ? 'HTTP / HTTPS' : 'SOCKS5'}
              </button>
            ))}
          </div>
        </div>

        {/* Session type */}
        <div className="p-5">
          <div className="text-sm font-medium text-ink mb-3">Session type</div>
          <div className="flex gap-3 mb-3">
            {(['rotating', 'sticky'] as const).map(t => (
              <button
                key={t}
                onClick={() => setSessionType(t)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-all ${
                  sessionType === t
                    ? 'bg-accent text-white border-accent'
                    : 'bg-white text-ink border-border hover:border-accent/40'
                }`}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          {sessionType === 'sticky' && (
            <div>
              <label className="block text-xs text-muted mb-1.5">Sticky duration</label>
              <select
                value={stickyDuration}
                onChange={e => setStickyDuration(Number(e.target.value))}
                className="w-full border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent bg-white"
              >
                <option value={1}>1 minute</option>
                <option value={10}>10 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>60 minutes</option>
              </select>
            </div>
          )}
        </div>

        {/* Endpoint count */}
        <div className="p-5">
          <div className="text-sm font-medium text-ink mb-1">Endpoint count</div>
          <p className="text-xs text-muted mb-3">How many connection strings to generate (1–10)</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setEndpointCount(Math.max(1, endpointCount - 1))}
              className="w-9 h-9 rounded-lg border border-border text-ink font-bold hover:bg-surface transition-colors"
            >−</button>
            <span className="font-mono text-lg w-8 text-center">{endpointCount}</span>
            <button
              onClick={() => setEndpointCount(Math.min(10, endpointCount + 1))}
              className="w-9 h-9 rounded-lg border border-border text-ink font-bold hover:bg-surface transition-colors"
            >+</button>
          </div>
        </div>

        {/* GB allocation */}
        <div className="p-5">
          <div className="text-sm font-medium text-ink mb-1">Bandwidth to allocate</div>
          <p className="text-xs text-muted mb-3">{availableGb.toFixed(1)} GB available</p>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={0.1}
              max={availableGb}
              step={0.1}
              value={gbAllocated}
              onChange={e => setGbAllocated(Number(e.target.value))}
              className="w-28 border border-border rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
            />
            <span className="text-sm text-muted">GB</span>
            <button
              onClick={() => setGbAllocated(availableGb)}
              className="text-xs text-accent hover:underline"
            >
              Use all
            </button>
          </div>
        </div>

        {/* Endpoint preview */}
        <div className="p-5 bg-surface rounded-b-xl">
          <div className="text-xs font-mono text-muted mb-2">Endpoint preview</div>
          <div className="font-mono text-xs text-ink bg-white border border-border rounded-lg px-3 py-2.5 break-all select-all">
            {previewEndpoint}
          </div>
        </div>

      </div>

      {error && (
        <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      <div className="flex gap-3 mt-6">
        <button
          onClick={() => router.back()}
          className="px-5 py-2.5 rounded-xl text-sm font-medium border border-border text-ink hover:bg-surface transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={loading || availableGb === 0}
          className="flex-1 bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium shadow-[0_2px_8px_rgba(0,87,255,.2)] hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0"
        >
          {loading ? 'Creating session…' : 'Create session'}
        </button>
      </div>
    </div>
  )
}
