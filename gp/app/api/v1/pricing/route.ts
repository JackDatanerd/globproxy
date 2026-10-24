import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { PLANS, CUSTOM_MIN_GB, CUSTOM_MAX_GB, quoteCustomGb } from '@/lib/plans'
import { NextResponse } from 'next/server'

// GET /api/v1/pricing[?gb=37] — what POST /api/v1/orders sells, in USD: the four fixed
// plans and the custom range. With ?gb=N it also prices exactly that quantity (the
// same function the checkout charges with), so an integration can show or check a
// price before it creates an order. Nothing here is private; it needs a key only so it
// shares the API's rate limits.
export async function GET(req: Request) {
  return withApiAuth(req, 'GET pricing', async () => {
    const raw = new URL(req.url).searchParams.get('gb')
    let quote: { gb: number; total_usd: number; price_per_gb: number } | undefined
    if (raw !== null) {
      const q = /^\d{1,6}$/.test(raw) ? quoteCustomGb(Number(raw)) : null
      if (!q) return apiError(400, 'invalid_request', `gb must be a whole number from ${CUSTOM_MIN_GB} to ${CUSTOM_MAX_GB} (500 GB and up is the "scale" plan).`)
      quote = { gb: q.gb, total_usd: q.total, price_per_gb: Math.round((q.total / q.gb) * 100) / 100 }
    }
    return NextResponse.json({
      currency: 'USD',
      plans: PLANS.filter((p) => !p.custom).map((p) => ({ slug: p.slug, name: p.name, gb: p.gb, price_per_gb: p.price, total_usd: p.total })),
      custom: { min_gb: CUSTOM_MIN_GB, max_gb: CUSTOM_MAX_GB },
      ...(quote ? { quote } : {}),
    }, { headers: { 'Cache-Control': 'private, max-age=60' } })
  })
}
