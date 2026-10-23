import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireStepUp } from '@/lib/reauth'
import { rateLimitedUser } from '@/lib/rateLimit'
import { rejectCrossSite } from '@/lib/apiAuth'

// "Download my data": everything the account holds about the signed-in person, as one
// JSON file — the counterpart of delete-account (the right to see your data comes
// before the right to erase it). Same gate as deletion: a signed-in session AND a
// password / authenticator step-up, because the file holds personal data.
//
// Explicit column lists, never select('*'): secrets (proxy passwords, key hashes,
// webhook signing secrets, supplier ids, internal fraud / moderation flags) are not
// the person's data to download and must never leave through an export.
const ROW_CAP = 10000

export async function GET(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Each export is ~12 queries; keep it to a few per minute per user.
    const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'export')
    if (throttled) return throttled

    const gate = await requireStepUp(req, user.id)
    if (gate) return gate

    const admin = await createAdminClient()
    const { data: me } = await admin.from('profiles').select('is_deleted').eq('id', user.id).maybeSingle()
    if (!me || me.is_deleted) return NextResponse.json({ error: 'This account no longer exists.' }, { status: 403 })

    const warnings: string[] = []
    const get = async (name: string, q: PromiseLike<{ data: any; error: { message: string } | null }>) => {
      const { data, error } = await q
      if (error) { warnings.push(`${name}: ${error.message}`); console.error('[export]', name, user.id, error.message); return null }
      return data
    }

    const out = {
      exported_at: new Date().toISOString(),
      account: {
        id: user.id,
        sign_in_email: user.email ?? null,
        created_at: user.created_at ?? null,
        last_sign_in_at: user.last_sign_in_at ?? null,
      },
      profile: await get('profile', admin.from('profiles').select(
        'full_name, email, company_name, billing_address, tax_id, role, reseller_status, api_access, affiliate_status, referral_code, ' +
        'payout_method, payout_mpesa_phone, payout_wallet_network, mfa_enabled, low_bandwidth_emails, created_at'
      ).eq('id', user.id).maybeSingle()),
      bandwidth: await get('bandwidth', admin.from('bandwidth_accounts').select(
        'total_gb, used_gb, allocated_gb, available_gb, created_at, updated_at'
      ).eq('user_id', user.id).maybeSingle()),
      orders: await get('orders', admin.from('orders').select(
        'id, gb_amount, amount_usd, payment_method, payment_status, paystack_reference, bandwidth_credited, invoice_number, refunded_usd, refunded_at, failure_reason, created_at, paid_at'
      ).eq('user_id', user.id).eq('is_canary', false).order('created_at', { ascending: false }).limit(ROW_CAP)),
      proxy_sessions: await get('proxy_sessions', admin.from('proxy_credentials').select(
        'id, label, status, protocol, session_type, sticky_duration, country, state, city, asn, gb_allocated, gb_used, created_at, activated_at'
      ).eq('user_id', user.id).order('created_at', { ascending: false }).limit(ROW_CAP)),
      daily_usage: await get('daily_usage', admin.from('usage_daily').select('day, gb').eq('user_id', user.id).order('day', { ascending: false }).limit(ROW_CAP)),
      api_keys: await get('api_keys', admin.from('api_keys').select(
        'id, key_prefix, label, scopes, created_at, last_used_at, expires_at, revoked_at, allowed_ips'
      ).eq('user_id', user.id).limit(ROW_CAP)),
      webhook_endpoints: await get('webhook_endpoints', admin.from('webhook_endpoints').select(
        'id, url, event_types, enabled, description, created_at'
      ).eq('user_id', user.id).limit(ROW_CAP)),
      support_reports: await get('support_reports', admin.from('support_reports').select(
        'id, message, page_url, status, created_at, resolved_at'
      ).eq('user_id', user.id).order('created_at', { ascending: false }).limit(ROW_CAP)),
      security_activity: await get('security_activity', admin.from('security_events').select(
        'event, ip, user_agent, created_at'
      ).eq('user_id', user.id).order('created_at', { ascending: false }).limit(ROW_CAP)),
      referrals_made: await get('referrals_made', admin.from('referrals').select(
        'code_used, created_at, gb_bonus_credited_at, gb_bonus_amount'
      ).eq('referrer_id', user.id).limit(ROW_CAP)),
      affiliate_commissions: await get('affiliate_commissions', admin.from('affiliate_commissions').select(
        'order_id, gross_amount_usd, commission_rate, commission_amount_usd, status, created_at, paid_at'
      ).eq('referrer_id', user.id).limit(ROW_CAP)),
      affiliate_payouts: await get('affiliate_payouts', admin.from('affiliate_payouts').select(
        'cycle_start, cycle_end, amount_usd, status, payout_method, created_at, paid_at'
      ).eq('referrer_id', user.id).limit(ROW_CAP)),
      ...(warnings.length ? { warnings } : {}),
    }

    return new NextResponse(JSON.stringify(out, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="globproxy-my-data-${new Date().toISOString().slice(0, 10)}.json"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('export unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
