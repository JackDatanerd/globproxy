import { getCloudflareContext } from '@opennextjs/cloudflare'

// The targeting catalogue (countries -> states -> cities, and ISPs per country)
// ships as static JSON under /public/geo, generated from the network's real
// supported values. /api/v1/locations* serves it to API users so they can find
// out which values are valid BEFORE a create call is rejected. Read through the
// ASSETS binding (no network hop); plain fetch is the fallback for local dev.
const cache = new Map<string, { at: number; data: unknown }>()
const TTL_MS = 10 * 60_000

export async function loadGeoAsset<T>(req: Request, path: string): Promise<T | null> {
  const hit = cache.get(path)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data as T
  const url = new URL(path, req.url)
  let res: Response
  try {
    const assets = (getCloudflareContext({ async: false }).env as { ASSETS?: { fetch: (r: Request) => Promise<Response> } }).ASSETS
    res = assets ? await assets.fetch(new Request(url)) : await fetch(url)
  } catch {
    res = await fetch(url)
  }
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`geo asset ${path} -> ${res.status}`)
  const data = (await res.json()) as T
  cache.set(path, { at: Date.now(), data })
  return data
}

export const COUNTRY_CODE_RE = /^[a-z]{2}$/

// State / city must exist in the country's catalogue, or the session can never connect (the network
// answers "no proxies available") while GB sits reserved against it. Fails OPEN: if the catalogue
// cannot be read, creation is not blocked. Returns the message to show, or null when fine.
export async function checkLocationInCatalogue(
  country: string | null | undefined, state: string | null | undefined, city: string | null | undefined,
): Promise<string | null> {
  if (!country || (!state && !city)) return null
  try {
    const origin = (process.env.NEXT_PUBLIC_APP_URL?.trim() || 'https://globproxy.com').replace(/\/+$/, '')
    const detail = await loadGeoAsset<{ states: { code: string; cities: { code: string }[] }[] }>(
      new Request(origin), `/geo/countries/${country}.json`,
    )
    if (!detail || !Array.isArray(detail.states)) return null
    if (state) {
      const st = detail.states.find((s) => s.code === state)
      if (!st) return `"${state}" is not a region we can target in ${country.toUpperCase()}. Pick one from GET /api/v1/locations/${country}.`
      if (city && !st.cities.some((c) => c.code === city)) return `"${city}" is not a city we can target in that region. Pick one from GET /api/v1/locations/${country}.`
      return null
    }
    if (city && !detail.states.some((s) => s.cities.some((c) => c.code === city))) {
      return `"${city}" is not a city we can target in ${country.toUpperCase()}. Pick one from GET /api/v1/locations/${country}.`
    }
    return null
  } catch (e) {
    console.error('[geo] catalogue check unavailable — not blocking', e)
    return null
  }
}
