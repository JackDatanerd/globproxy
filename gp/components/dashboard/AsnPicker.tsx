'use client'
import { useEffect, useState } from 'react'
import { fetchCountryAsns, type AsnOption } from '@/lib/geoTargeting'

// ISP (ASN) targeting input. With a country selected it suggests the ISPs that
// actually exist there (type a name or number); an ASN that isn't in that
// country's list is flagged, because the API rejects it — a session pinned to
// an ASN with no peers would otherwise connect to nothing. Without a country
// it stays a plain numeric field. The value is always digits only.
export default function AsnPicker({
  country, value, onChange, className,
}: { country: string; value: string; onChange: (v: string) => void; className: string }) {
  const [options, setOptions] = useState<AsnOption[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!country) { setOptions([]); setLoaded(false); return }
    let cancelled = false
    setLoaded(false)
    fetchCountryAsns(country)
      .then(o => { if (!cancelled) { setOptions(o); setLoaded(true) } })
      .catch(() => { if (!cancelled) { setOptions([]); setLoaded(true) } })
    return () => { cancelled = true }
  }, [country])

  const listId = `asn-options-${country || 'none'}`
  const trimmed = value.trim()
  const match = options.find(o => o.code === trimmed)
  // Accept a pasted "AS7922" or "AS7922 COMCAST…" and keep just the digits.
  function handleChange(raw: string) {
    const m = raw.match(/^\s*(?:AS)?(\d{1,10})/i)
    onChange(m ? m[1] : raw.replace(/[^\d]/g, ''))
  }

  return (
    <div>
      <input
        value={value}
        onChange={e => handleChange(e.target.value)}
        inputMode="numeric"
        list={options.length > 0 ? listId : undefined}
        placeholder={country && options.length > 0 ? 'Search ISP or number' : 'e.g. 7922'}
        className={className}
      />
      {options.length > 0 && (
        <datalist id={listId}>
          {options.map(o => <option key={o.code} value={o.code}>{o.name}</option>)}
        </datalist>
      )}
      {trimmed && match && <p className="text-[10.5px] text-muted mt-1 truncate">{match.name}</p>}
      {trimmed && country && loaded && options.length > 0 && !match && (
        <p className="text-[10.5px] text-red-600 mt-1">AS{trimmed} isn’t available in this country — pick one from the list.</p>
      )}
      {!country && <p className="text-[10.5px] text-muted mt-1">Choose a country to browse its ISPs.</p>}
    </div>
  )
}
