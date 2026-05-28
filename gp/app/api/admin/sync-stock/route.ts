import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createAdminClient()
  const resellerId = process.env.GEONODE_RESELLER_ID
  const apiKey = process.env.GEONODE_API_KEY

  const url = `https://app-api.geonode.com/api/reseller/v2/${resellerId}/services/RESIDENTIAL-PREMIUM/traffic/summary`

  let rawStatus: number | null = null
  let rawBody: string | null = null

  try {
    const res = await fetch(url, {
      headers: {
        'r-api-key': apiKey ?? '', // ✅ FIXED: was 'Reseller-Api-Key', correct header is 'r-api-key'
        'Content-Type': 'application/json',
      },
    })
    rawStatus = res.status
    rawBody = await res.text()
  } catch (err: any) {
    return NextResponse.json({
      debug: true,
      reseller_id: resellerId ?? 'MISSING',
      api_key_present: !!apiKey,
      api_key_prefix: apiKey ? apiKey.slice(0, 8) + '...' : 'MISSING',
      url,
      fetch_error: err.message,
    })
  }

  return NextResponse.json({
    debug: true,
    reseller_id: resellerId ?? 'MISSING',
    api_key_present: !!apiKey,
    api_key_prefix: apiKey ? apiKey.slice(0, 8) + '...' : 'MISSING',
    url,
    geonode_status: rawStatus,
    geonode_body: rawBody,
  })
}
