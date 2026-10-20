import { createAdminClient } from '@/lib/supabase/server'
import { getKesQuote } from '@/lib/fx'
import { rateLimited } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Which payment methods the buy page can offer right now, and the KES rate to
// price M-Pesa with. Holds nothing private (the rate is shown to every
// customer), but a miss can trigger a live FX fetch, so it shares the payment
// rate limit.
export async function GET(req: Request) {
  const limited = await rateLimited(req, 'PAYMENT_RATE_LIMITER')
  if (limited) return limited
  try {
    const quote = await getKesQuote(await createAdminClient())
    return NextResponse.json(
      { mpesa: quote ? { available: true, rate: quote.rate } : { available: false } },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    console.error('[checkout/options]', e)
    // Card always works; failing to price M-Pesa just hides it.
    return NextResponse.json({ mpesa: { available: false } }, { headers: { 'Cache-Control': 'no-store' } })
  }
}
