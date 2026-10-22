import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser, rejectCrossSite } from '@/lib/apiAuth'
import { requireMfaVerified } from '@/lib/mfa'
import { rateLimited } from '@/lib/rateLimit'
import { cleanNumber } from '@/lib/validation'
import { NextResponse } from 'next/server'

// Reseller preferences. Today: the low-stock alert threshold (GB). Send
// { low_stock_gb: null } (or 0) to switch the alert off.
export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'reseller') return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
    const mfa = await requireMfaVerified(req, user.id)
    if (mfa) return mfa
    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive
    const limited = await rateLimited(req, 'RESELLER_RATE_LIMITER', `settings:${user.id}`)
    if (limited) return limited

    let body: any
    try { body = await req.json() } catch { body = null }
    if (!body || !('low_stock_gb' in body)) return NextResponse.json({ error: 'low_stock_gb is required' }, { status: 400 })

    let value: number | null = null
    if (body.low_stock_gb !== null && body.low_stock_gb !== '') {
      const n = cleanNumber(body.low_stock_gb)
      if (n === null || n < 0 || n > 1_000_000 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) {
        return NextResponse.json({ error: 'Enter a threshold between 0 and 1,000,000 GB (up to 3 decimals), or leave it empty to turn the alert off.' }, { status: 400 })
      }
      value = n === 0 ? null : Math.round(n * 1000) / 1000
    }
    const admin = await createAdminClient()
    const { error } = await admin.from('profiles')
      .update({ reseller_low_stock_gb: value, reseller_low_stock_alerted_at: null }).eq('id', user.id)
    if (error) {
      console.error('[reseller/settings] update failed', error)
      return NextResponse.json({ error: 'Could not save this setting.' }, { status: 500 })
    }
    return NextResponse.json({ success: true, low_stock_gb: value })
  } catch (err) {
    console.error('[reseller/settings] error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
