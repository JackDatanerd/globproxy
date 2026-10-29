import { createAdminClient } from '@/lib/supabase/server'
import { getKesQuote } from '@/lib/fx'
import { publicPromo } from '@/lib/promo'
import { rateLimited } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Which payment methods the buy page can offer right now, and the KES rate to
// price M-Pesa with. Holds nothing private (the rate is shown to every
// customer), but a miss can trigger a live FX fetch, so it shares the payment
// rate limit. `promo` is the M-Pesa offer while it is live (percent, deadline, label), else null.
export async function GET(req: Request) {
  const limited = await rateLimited(req, 'PAYMENT_RATE_LIMITER', 'options')
  if (limited) return limited
  try {
    const quote = await getKesQuote(await createAdminClient())
    return NextResponse.json(
      { mpesa: quote ? { available: true, rate: quote.rate, promo: publicPromo(quote.promo) } : { available: false } },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    console.error('[checkout/options]', e)
    // Card always works. A 503 (not a 200 "unavailable") tells the buy page this is a failure to
    // look it up, so it retries instead of treating M-Pesa as switched off.
    return NextResponse.json({ mpesa: { available: false } }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
