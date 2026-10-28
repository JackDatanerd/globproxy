'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { apiJson, toastApiError } from '@/lib/clientApi'
import {
  fetchCountryList, fetchCountryDetail,
  type CountryListItem, type CountryDetail,
} from '@/lib/geoTargeting'
import AsnPicker from '@/components/dashboard/AsnPicker'
import StickyDurationSelect from '@/components/dashboard/StickyDurationSelect'

// "Edit" tab: rename or retarget an existing session in place. Everything
// here is database-only (see updateCredentialSettings in lib/credentials.ts) —
// targeting is just a username suffix and the port follows from
// protocol + session type — so changing where a session exits no longer
// means delete + recreate (the one path that rounds, refunds and archives GB).
// Existing sticky sessions keep working; they just pick up the new targeting
// the next time a connection is made with the updated username.

const field = 'w-full bg-white border border-border px-3 py-2 rounded-lg text-xs focus:outline-none focus:border-accent transition-colors disabled:opacity-50'

export default function CredentialSettings({ cred }: { cred: any }) {
  const router = useRouter()
  const [label, setLabel] = useState<string>(cred.label ?? '')
  const [protocol, setProtocol] = useState<string>(cred.protocol ?? 'http')
  const [sessionType, setSessionType] = useState<string>(cred.session_type ?? 'rotating')
  const [stickyDuration, setStickyDuration] = useState<number>(cred.sticky_duration ?? 10)
  const [country, setCountry] = useState<string>(cred.country ?? '')
  const [state, setState] = useState<string>(cred.state ?? '')
  const [city, setCity] = useState<string>(cred.city ?? '')
  const [asn, setAsn] = useState<string>(cred.asn ?? '')

  const [countries, setCountries] = useState<CountryListItem[]>([])
  const [detail, setDetail] = useState<CountryDetail | null>(null)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchCountryList().then(setCountries).catch(e => setGeoError(e.message))
  }, [])

  useEffect(() => {
    // Drop the previous country's regions immediately, so none of them can be picked (and saved)
    // for the new country while its own list is still loading.
    setDetail(null)
    if (!country) return
    let cancelled = false
    fetchCountryDetail(country)
      .then(d => { if (!cancelled) { setDetail(d); setGeoError(null) } })
      .catch(e => { if (!cancelled) setGeoError(e.message) })
    return () => { cancelled = true }
  }, [country])

  const stateOption = detail?.states.find(s => s.code === state) ?? null

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (asn.trim() && !/^\d{1,10}$/.test(asn.trim())) { toast.error('ASN must be numeric'); return }
    setSaving(true)
    try {
      await apiJson('PATCH', `/api/dashboard/proxies/${cred.id}`, {
        label: label.trim() || null,
        protocol,
        session_type: sessionType,
        sticky_duration: sessionType === 'sticky' ? stickyDuration : null,
        // Targeting is sent as a group.
        country: country || null,
        state: country ? state || null : null,
        city: country && state ? city || null : null,
        asn: asn.trim() || null,
      })
      toast.success('Session updated')
      router.refresh()
    } catch (err: any) {
      toastApiError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="mb-2 space-y-3">
      <p className="text-[10.5px] text-muted">
        Changes apply to new connections — update the username in anything already using this session
        (copy it again from the Credentials tab). Your bandwidth is not affected.
      </p>

      <div>
        <label className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Label</label>
        <input value={label} onChange={e => setLabel(e.target.value)} maxLength={100} placeholder="e.g. Price scraper" className={field} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Protocol</label>
          <select value={protocol} onChange={e => setProtocol(e.target.value)} className={field}>
            <option value="http">HTTP / HTTPS</option>
            <option value="socks5">SOCKS5</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1">IP behaviour</label>
          <select value={sessionType} onChange={e => setSessionType(e.target.value)} className={field}>
            <option value="rotating">Rotating (new IP per request)</option>
            <option value="sticky">Sticky (keep the same IP)</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Sticky duration</label>
          <StickyDurationSelect value={stickyDuration} onChange={setStickyDuration}
            disabled={sessionType !== 'sticky'} className={field} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Country</label>
          <select value={country}
            onChange={e => { setCountry(e.target.value); setState(''); setCity(''); setAsn('') }} className={field}>
            <option value="">Any country</option>
            {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1">State / region</label>
          <select value={state} onChange={e => { setState(e.target.value); setCity(''); if (e.target.value) setAsn('') }}
            disabled={!country || !detail || detail.states.length === 0} className={field}>
            <option value="">Any</option>
            {detail?.states.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1">City</label>
          <select value={city} onChange={e => { setCity(e.target.value); if (e.target.value) setAsn('') }} disabled={!state || !stateOption} className={field}>
            <option value="">Any</option>
            {stateOption?.cities.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </div>
      </div>
      {geoError && <p className="text-xs text-red-600">Couldn’t load locations — {geoError}</p>}

      <div className="max-w-[320px]">
        <label className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1">ISP / ASN <span className="normal-case">(optional)</span></label>
        <AsnPicker country={country} value={asn} onChange={setAsn} className={field}
          blockedReason={!country ? 'Choose a country to pick an ISP.'
            : (state || city) ? (asn.trim() ? 'This ISP is not used while a state or city is set — the location wins. Set the region to “Any” to use the ISP.' : 'ISP targeting is country-wide. Set the region to “Any” to pick an ISP.')
            : undefined} />
      </div>

      <button type="submit" disabled={saving}
        className="bg-accent text-white px-4 py-2 rounded-lg text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  )
}
