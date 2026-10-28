'use client'
import { useEffect, useState } from 'react'
import { fetchCountryAsns, type AsnOption } from '@/lib/geoTargeting'

// ISP (ASN) targeting input. With a country selected it suggests the ISPs that
// actually exist there (type a name or number); an ASN that isn't in that
// country's list is flagged, because the API rejects it — a session pinned to
// an ASN with no peers would otherwise connect to nothing. ISP targeting is
// country-wide: with no country, or with a state or city chosen, the box is
// disabled (`blockedReason` says why) because the network cannot serve an ISP
// inside one city. The value handed to the parent is always digits only; the
// box itself keeps whatever the customer is typing so an ISP *name* can be
// searched (the browser filters the list as they type).
export default function AsnPicker({
  country, value, onChange, className, blockedReason,
}: { country: string; value: string; onChange: (v: string) => void; className: string; blockedReason?: string }) {
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
  // What the customer sees in the box. The parent's `value` is digits only.
  const [text, setText] = useState(value)
  useEffect(() => {
    // Parent changed the value itself (country reset, saved default) — resync,
    // unless the text already means it (typing "AS79" must not become "79").
    if (digitsOf(text) !== value && !(value === '' && isSearching(text))) setText(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // The box was blocked (a region was chosen, so the parent cleared the ISP): a half-typed ISP-name
  // search left in the now-disabled input would look like a selection, so clear it.
  useEffect(() => {
    if (blockedReason && value === '' && isSearching(text)) setText('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockedReason])

  const trimmed = value.trim()
  const match = options.find(o => o.code === trimmed)
  // Accept a pasted "AS7922" or "AS7922 COMCAST…" (digits are kept); anything
  // with no leading number is an ISP-name search — shown, but not a value.
  function handleChange(raw: string) {
    // Without a country list there is nothing to search — digits only.
    if (options.length === 0) {
      const d = digitsOf(raw) || raw.replace(/[^\d]/g, '')
      setText(d); onChange(d); return
    }
    // An exact ISP name (typed or pasted) resolves to its number.
    const byName = options.find(o => o.name.trim().toLowerCase() === raw.trim().toLowerCase())
    if (byName) { setText(byName.code); onChange(byName.code); return }
    setText(raw)
    onChange(digitsOf(raw))
  }
  const searching = isSearching(text)

  return (
    <div>
      <input
        value={text}
        onChange={e => handleChange(e.target.value)}
        onBlur={() => { if (searching) setText('') }}
        disabled={!!blockedReason}
        inputMode={options.length > 0 ? 'search' : 'numeric'}
        list={options.length > 0 ? listId : undefined}
        placeholder={country && options.length > 0 ? 'Search ISP or number' : 'e.g. 7922'}
        className={className}
      />
      {options.length > 0 && (
        <datalist id={listId}>
          {options.map(o => <option key={o.code} value={o.code}>{o.name}</option>)}
        </datalist>
      )}
      {blockedReason && <p className="text-[10.5px] text-muted mt-1">{blockedReason}</p>}
      {!blockedReason && trimmed && <p className="text-[10.5px] text-muted mt-1">Not every ISP has addresses online at every moment. If a connection fails with “no proxies available”, pick another ISP or use the country only.</p>}
      {searching && options.length > 0 && <p className="text-[10.5px] text-muted mt-1">Pick an ISP from the list to select it.</p>}
      {trimmed && match && <p className="text-[10.5px] text-muted mt-1 truncate">{match.name}</p>}
      {trimmed && country && loaded && options.length > 0 && !match && (
        <p className="text-[10.5px] text-red-600 mt-1">AS{trimmed} isn’t available in this country — pick one from the list.</p>
      )}
    </div>
  )
}

function digitsOf(raw: string): string {
  const m = raw.match(/^\s*(?:AS)?(\d{1,10})/i)
  return m ? m[1] : ''
}
// Text with no leading ASN number = the customer is searching by ISP name.
function isSearching(raw: string): boolean {
  return raw.trim() !== '' && digitsOf(raw) === ''
}
