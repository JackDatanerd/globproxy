import { NextResponse } from 'next/server'
import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { loadGeoAsset, COUNTRY_CODE_RE } from '@/lib/geoAssets'

// GET /api/v1/locations/{country}/asns — the ISPs (ASNs) available in a country,
// for the `asn` field of POST /sub-users. A known country with no ISP data returns
// an empty list (ISP targeting simply isn't offered there); an unknown code is a 404.
export async function GET(req: Request, context: { params: Promise<{ country: string }> }) {
  return withApiAuth(req, 'GET location asns', async () => {
    const country = (await context.params).country.toLowerCase()
    if (!COUNTRY_CODE_RE.test(country)) return apiError(400, 'invalid_request', 'country must be a 2-letter code from GET /api/v1/locations.')
    const list = await loadGeoAsset<{ code: string; name: string }[]>(req, `/geo/asns/${country}.json`).catch(() => 'error' as const)
    if (list === 'error') return apiError(503, 'service_unavailable', 'The ISP catalogue is temporarily unavailable. Try again shortly.')
    // An empty list is only right for a REAL country that has no ISP data; a code
    // that is not in the catalogue at all is a 404, same as GET /locations/{country}.
    if (!list) {
      const known = await loadGeoAsset<{ code: string }>(req, `/geo/countries/${country}.json`).catch(() => 'error' as const)
      if (known === 'error') return apiError(503, 'service_unavailable', 'The ISP catalogue is temporarily unavailable. Try again shortly.')
      if (!known) return apiError(404, 'not_found', 'Unknown country code. List valid codes with GET /api/v1/locations.')
    }
    return NextResponse.json({
      country,
      asns: (list ?? []).map((a) => ({ asn: Number(a.code), name: a.name })),
    }, { headers: { 'Cache-Control': 'private, max-age=300' } })
  })
}
