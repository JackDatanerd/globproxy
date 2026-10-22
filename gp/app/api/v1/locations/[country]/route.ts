import { NextResponse } from 'next/server'
import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { loadGeoAsset, COUNTRY_CODE_RE } from '@/lib/geoAssets'

// GET /api/v1/locations/{country}?cities=false — the states/regions of one
// country, each with its cities, using the exact codes accepted as `state` and
// `city` on POST /sub-users. cities=false drops the city lists (the United
// States alone has thousands) when you only need the states.
export async function GET(req: Request, context: { params: Promise<{ country: string }> }) {
  return withApiAuth(req, 'GET location', async () => {
    const country = (await context.params).country.toLowerCase()
    if (!COUNTRY_CODE_RE.test(country)) return apiError(400, 'invalid_request', 'country must be a 2-letter code from GET /api/v1/locations.')
    const detail = await loadGeoAsset<{ code: string; name: string; states: { code: string; name: string; cities: { code: string; name: string }[] }[] }>(
      req, `/geo/countries/${country}.json`,
    ).catch(() => 'error' as const)
    if (detail === 'error') return apiError(503, 'service_unavailable', 'The location catalogue is temporarily unavailable. Try again shortly.')
    if (!detail) return apiError(404, 'not_found', 'Unknown country code. List valid codes with GET /api/v1/locations.')
    const withCities = new URL(req.url).searchParams.get('cities') !== 'false'
    return NextResponse.json({
      code: detail.code,
      name: detail.name,
      states: detail.states.map((s) => ({ code: s.code, name: s.name, ...(withCities ? { cities: s.cities } : { city_count: s.cities.length }) })),
    }, { headers: { 'Cache-Control': 'private, max-age=300' } })
  })
}
