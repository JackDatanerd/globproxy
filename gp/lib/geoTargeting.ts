// Data-driven replacement for hand-typed state/city fields on the proxy
// creation form. Backed by static JSON under /public/geo, generated from
// Geonode's real /targeting-options response (see scripts_gen_geo.py) — so
// every value a user can pick here is guaranteed to be one Geonode actually
// supports, instead of a free-text field a customer could mistype.
//
// codes returned here (country/state/city) are already in the exact format
// buildProxyUsername()'s slug() expects (lowercase, no spaces) — Geonode's
// own codes are pre-slugged, confirmed against the source data, so no
// transformation happens in this file or at submit time.

export interface CountryListItem {
  code: string
  name: string
  stateCount: number
}

export interface CityOption {
  code: string
  name: string
}

export interface StateOption {
  code: string
  name: string
  cities: CityOption[]
}

export interface CountryDetail {
  code: string
  name: string
  states: StateOption[]
}

// A handful of codes to float to the top of the country dropdown as
// "Popular" — purely cosmetic ordering, doesn't affect what's selectable.
export const POPULAR_COUNTRY_CODES = new Set([
  'us', 'gb', 'ca', 'au', 'de', 'fr',
])

let countryListCache: CountryListItem[] | null = null
const countryDetailCache = new Map<string, CountryDetail>()

export async function fetchCountryList(): Promise<CountryListItem[]> {
  if (countryListCache) return countryListCache
  const res = await fetch('/geo/countries.json')
  if (!res.ok) throw new Error(`Failed to load country list (${res.status})`)
  const data: CountryListItem[] = await res.json()
  countryListCache = data
  return data
}

// Fetches the full state/city tree for one country. Cached per-country
// since re-selecting a country the user already visited (e.g. toggling
// back and forth) shouldn't re-fetch.
export async function fetchCountryDetail(countryCode: string): Promise<CountryDetail> {
  const cached = countryDetailCache.get(countryCode)
  if (cached) return cached
  const res = await fetch(`/geo/countries/${countryCode}.json`)
  if (!res.ok) throw new Error(`Failed to load locations for "${countryCode}" (${res.status})`)
  const data: CountryDetail = await res.json()
  countryDetailCache.set(countryCode, data)
  return data
}
