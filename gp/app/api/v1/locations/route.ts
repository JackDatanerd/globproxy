import { NextResponse } from 'next/server'
import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { loadGeoAsset } from '@/lib/geoAssets'

// GET /api/v1/locations — every country you can target, with the code to pass as
// `country` when creating a sub-user. state_count is how many states/regions
// GET /api/v1/locations/{country} lists for it.
export async function GET(req: Request) {
  return withApiAuth(req, 'GET locations', async () => {
    const list = await loadGeoAsset<{ code: string; name: string; stateCount: number }[]>(req, '/geo/countries.json').catch(() => null)
    if (!list) return apiError(503, 'service_unavailable', 'The location catalogue is temporarily unavailable. Try again shortly.')
    return NextResponse.json({
      countries: list.map((c) => ({ code: c.code, name: c.name, state_count: c.stateCount })),
    }, { headers: { 'Cache-Control': 'private, max-age=300' } })
  })
}
