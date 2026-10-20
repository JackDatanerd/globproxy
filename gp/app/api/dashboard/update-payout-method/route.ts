import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { normalizeMpesaPhone } from '@/lib/mpesa'
import { isValidTronAddress } from '@/lib/tron'
import { requireStepUp } from '@/lib/reauth'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimited } from '@/lib/rateLimit'
import { cleanText } from '@/lib/validation'
import { AFFILIATE_HOLD_HOURS } from '@/lib/referrals'
import { rejectCrossSite } from '@/lib/apiAuth'
import { logSecurityEvent } from '@/lib/securityEvents'

type BankDetails = { bankName: string; accountName: string; accountNumber: string; country: string; swift: string | null }

// Everything below runs on VALIDATED strings only. The previous version
// built this display string from raw request values AFTER the database write
// — a numeric accountNumber threw inside the email template, so the change
// was saved (hold timer started) but the security notification never went
// out, which let a hijacked session change a destination silently. It also
// interpolated bankName into the email HTML unescaped.
function maskDestination(method: string, d: { wallet?: string; phone?: string; bank?: BankDetails }): string {
  if (method === 'usdt') {
    const addr = d.wallet ?? ''
    return `USDT (TRC20) · ${addr.slice(0, 6)}…${addr.slice(-4)}`
  }
  if (method === 'mpesa') {
    const phone = d.phone ?? ''
    return `M-Pesa · ${phone.slice(0, 6)}***${phone.slice(-2)}`
  }
  return `Bank transfer · ${d.bank?.bankName ?? ''} · ****${(d.bank?.accountNumber ?? '').slice(-4)}`
}

export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  try {
    // Authenticate with the regular session client — this route lets a
    // user set their OWN payout details, never someone else's.
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'payout-method')
    if (limited) return limited
    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive

    // 2FA step-up — redirecting payouts is the classic account-takeover
    // cash-out, so an enrolled account needs a verified session, not just a
    // password. See lib/mfa.ts.
    const mfaGate = await requireStepUp(req, user.id)
    if (mfaGate) return mfaGate

    const adminSupabase = await createAdminClient()
    const { data: me } = await adminSupabase
      .from('profiles')
      .select('payout_method, payout_wallet_address, payout_mpesa_phone, payout_bank_details')
      .eq('id', user.id)
      .single()

    let body: any
    try { body = await req.json() } catch { body = null }
    const method = body?.method

    if (method !== 'usdt' && method !== 'bank' && method !== 'mpesa') {
      return NextResponse.json({ error: 'method must be "usdt", "bank", or "mpesa"' }, { status: 400 })
    }

    // Base object nulls every method's fields; the branch below fills in
    // only the ones for the method actually being set. Keeps "switching
    // from bank to usdt" from leaving stale bank details sitting around.
    const update: Record<string, unknown> = {
      payout_method: method,
      payout_wallet_address: null,
      payout_wallet_network: null,
      payout_bank_details: null,
      payout_mpesa_phone: null,
    }
    const display: { wallet?: string; phone?: string; bank?: BankDetails } = {}

    if (method === 'usdt') {
      const wallet = cleanText(body?.walletAddress, 64)
      if (!wallet || !(await isValidTronAddress(wallet))) {
        return NextResponse.json(
          { error: "That isn't a valid TRC20 (Tron) wallet address — check it for typos (the address checksum failed)." },
          { status: 400 }
        )
      }
      update.payout_wallet_address = wallet
      update.payout_wallet_network = 'TRC20'
      display.wallet = wallet
    } else if (method === 'mpesa') {
      const phone = typeof body?.mpesaPhone === 'string' ? normalizeMpesaPhone(body.mpesaPhone) : null
      if (!phone) {
        return NextResponse.json({ error: "That doesn't look like a valid Kenyan mobile (M-Pesa) number" }, { status: 400 })
      }
      update.payout_mpesa_phone = phone
      display.phone = phone
    } else {
      const raw = body?.bankDetails
      const bank: BankDetails | null = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? {
            bankName: cleanText(raw.bankName, 100) ?? '',
            accountName: cleanText(raw.accountName, 120) ?? '',
            accountNumber: cleanText(raw.accountNumber, 64) ?? '',
            country: cleanText(raw.country, 80) ?? '',
            swift: cleanText(raw.swift, 20) ?? null,
          }
        : null
      if (!bank || !bank.bankName || !bank.accountName || !bank.accountNumber || !bank.country) {
        return NextResponse.json(
          { error: 'Bank name, account name, account number, and country are required (text, within the length limits)' },
          { status: 400 }
        )
      }
      update.payout_bank_details = bank
      display.bank = bank
    }

    // A re-save of the details already on file must not restart the 48h hold
    // (it would let anyone with a stale tab — or an attacker griefing a
    // legitimate user — keep a payout permanently "recently changed").
    const unchanged = !!me &&
      me.payout_method === method &&
      ((method === 'usdt' && me.payout_wallet_address === update.payout_wallet_address) ||
        (method === 'mpesa' && me.payout_mpesa_phone === update.payout_mpesa_phone) ||
        (method === 'bank' && JSON.stringify(me.payout_bank_details ?? null) === JSON.stringify(update.payout_bank_details)))
    if (unchanged) {
      return NextResponse.json({ success: true, unchanged: true })
    }

    // payout_method_updated_at is set here, server-side, unconditionally —
    // never accepted from the request body. It's what the hold in
    // run_affiliate_payout_cycle checks against.
    update.payout_method_updated_at = new Date().toISOString()

    const { data: profile, error: updateError } = await adminSupabase
      .from('profiles')
      .update(update)
      .eq('id', user.id)
      .select('email, full_name')
      .single()

    if (updateError) {
      console.error('[payout-method] update failed', user.id, updateError.message)
      return NextResponse.json({ error: 'Could not save your payout method. Please try again.' }, { status: 500 })
    }

    // Shows up in the account's security history (the destination itself is
    // never logged — only which method it moved from/to). The 48h hold is set
    // above; this event type is deliberately not one that re-bumps it.
    await logSecurityEvent({
      userId: user.id, event: 'payout_method_changed', req,
      meta: { from: me?.payout_method ?? null, to: method },
    })

    // Security notification — the other half of the hold. Failure to build or
    // send it is logged loudly but never turns the (already committed) change
    // into an error response.
    if (profile?.email) {
      try {
        await sendEmail({
          to: profile.email,
          subject: 'Your GlobProxy payout details were changed',
          html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Payout details updated</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(profile.full_name?.split(' ')[0]) || 'there'}, your affiliate payout method was just set to:
            </p>
            <p style="text-align:center;font-family:monospace;font-size:13px;color:#111;background:#f5f5f5;padding:12px 16px;border-radius:8px;">
              ${escapeHtml(maskDestination(method, display))}
            </p>
            <p style="color:#444;text-align:center;">
              For security, this takes ${AFFILIATE_HOLD_HOURS} hours before it's eligible for a payout.
              <strong>If you didn't make this change, contact support immediately</strong> — someone else may have access to your account.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="mailto:support@globproxy.com"
                 style="background:#dc2626;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                This wasn't me →
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © 2026 GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
        })
      } catch (e) {
        console.error('[payout-method] SECURITY NOTIFICATION FAILED — change is saved', user.id, e)
      }
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[dashboard/update-payout-method] unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
