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
