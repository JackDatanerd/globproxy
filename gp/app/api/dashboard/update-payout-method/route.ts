import { NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { normalizeMpesaPhone } from '@/lib/mpesa'
import { requireMfaVerified } from '@/lib/mfa'

// TRC20 (Tron) addresses are base58, start with 'T', 34 characters —
// this is a format sanity check, not a checksum validator. Catches the
// obvious "pasted the wrong thing" mistakes without pretending to fully
// validate the address.
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

function maskDestination(method: string, update: Record<string, unknown>): string {
  if (method === 'usdt') {
    const addr = String(update.payout_wallet_address ?? '')
    return `USDT (TRC20) · ${addr.slice(0, 6)}…${addr.slice(-4)}`
  }
  if (method === 'mpesa') {
    const phone = String(update.payout_mpesa_phone ?? '')
    return `M-Pesa · ${phone.slice(0, 6)}***${phone.slice(-2)}`
  }
  const bank = update.payout_bank_details as { bankName?: string; accountNumber?: string } | null
  return `Bank transfer · ${bank?.bankName ?? ''} · ****${(bank?.accountNumber ?? '').slice(-4)}`
}

export async function POST(req: Request) {
  try {
    // Authenticate with the regular session client — this route lets a
    // user set their OWN payout details, never someone else's.
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive

    // 2FA step-up — redirecting payouts is the classic account-takeover
    // cash-out, so an enrolled account needs a verified session, not just a
    // password. See lib/mfa.ts.
    const mfaGate = await requireMfaVerified(req, user.id)
    if (mfaGate) return mfaGate

    const { method, walletAddress, bankDetails, mpesaPhone } = await req.json()

    if (method !== 'usdt' && method !== 'bank' && method !== 'mpesa') {
      return NextResponse.json({ error: 'method must be "usdt", "bank", or "mpesa"' }, { status: 400 })
    }

    // Base object nulls every method's fields; the branch below fills in
    // only the ones for the method actually being set. Keeps "switching
    // from bank to usdt" from leaving stale bank details sitting around.
    let update: Record<string, unknown> = {
      payout_method: method,
      payout_wallet_address: null,
      payout_wallet_network: null,
      payout_bank_details: null,
      payout_mpesa_phone: null,
    }

    if (method === 'usdt') {
      if (typeof walletAddress !== 'string' || !TRON_ADDRESS_RE.test(walletAddress.trim())) {
        return NextResponse.json({ error: 'That doesn\'t look like a valid TRC20 (Tron) wallet address' }, { status: 400 })
      }
      update.payout_wallet_address = walletAddress.trim()
      update.payout_wallet_network = 'TRC20'
    } else if (method === 'mpesa') {
      const normalized = typeof mpesaPhone === 'string' ? normalizeMpesaPhone(mpesaPhone) : null
      if (!normalized) {
        return NextResponse.json({ error: 'That doesn\'t look like a valid Safaricom M-Pesa number' }, { status: 400 })
      }
      update.payout_mpesa_phone = normalized
    } else {
      const { bankName, accountName, accountNumber, country, swift } = bankDetails ?? {}
      if (!bankName || !accountName || !accountNumber || !country) {
        return NextResponse.json({ error: 'Bank name, account name, account number, and country are required' }, { status: 400 })
      }
      update.payout_bank_details = { bankName, accountName, accountNumber, country, swift: swift || null }
    }

    // payout_method_updated_at is set here, server-side, unconditionally —
    // never accepted from the request body. protect_privileged_profile_
    // columns (migrations 0034/0035) would reset it anyway on a direct
    // client write, but this route is the actual intended path regardless:
    // it's what the 48h hold in run_affiliate_payout_cycle checks against,
    // so it must reflect exactly when the change really happened.
    update.payout_method_updated_at = new Date().toISOString()

    const adminSupabase = await createAdminClient()
    const { data: profile, error: updateError } = await adminSupabase
      .from('profiles')
      .update(update)
      .eq('id', user.id)
      .select('email, full_name')
      .single()

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // Security notification — this is the other half of the 48h hold:
    // the hold buys time, this is what actually gives the real affiliate
    // a chance to notice a change they didn't make and act on it before
    // the hold expires. Sent to the account's own verified email, best
    // effort, never allowed to affect this response.
    if (profile?.email) {
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
              ${maskDestination(method, update)}
            </p>
            <p style="color:#444;text-align:center;">
              For security, this takes 48 hours before it's eligible for a payout.
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
      }).catch(() => {})
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[dashboard/update-payout-method] unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
