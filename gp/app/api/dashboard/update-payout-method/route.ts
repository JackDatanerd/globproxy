import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

// TRC20 (Tron) addresses are base58, start with 'T', 34 characters —
// this is a format sanity check, not a checksum validator. Catches the
// obvious "pasted the wrong thing" mistakes without pretending to fully
// validate the address.
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

export async function POST(req: Request) {
  try {
    // Authenticate with the regular session client — this route lets a
    // user set their OWN payout details, never someone else's.
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { method, walletAddress, bankDetails } = await req.json()

    if (method !== 'usdt' && method !== 'bank') {
      return NextResponse.json({ error: 'method must be "usdt" or "bank"' }, { status: 400 })
    }

    let update: Record<string, unknown>

    if (method === 'usdt') {
      if (typeof walletAddress !== 'string' || !TRON_ADDRESS_RE.test(walletAddress.trim())) {
        return NextResponse.json({ error: 'That doesn\'t look like a valid TRC20 (Tron) wallet address' }, { status: 400 })
      }
      update = {
        payout_method: 'usdt',
        payout_wallet_address: walletAddress.trim(),
        payout_wallet_network: 'TRC20',
        payout_bank_details: null,
      }
    } else {
      const { bankName, accountName, accountNumber, country, swift } = bankDetails ?? {}
      if (!bankName || !accountName || !accountNumber || !country) {
        return NextResponse.json({ error: 'Bank name, account name, account number, and country are required' }, { status: 400 })
      }
      update = {
        payout_method: 'bank',
        payout_wallet_address: null,
        payout_wallet_network: null,
        payout_bank_details: { bankName, accountName, accountNumber, country, swift: swift || null },
      }
    }

    // payout_method_updated_at is set here, server-side, unconditionally —
    // never accepted from the request body. protect_privileged_profile_
    // columns (migration 0034) would reset it anyway on a direct client
    // write, but this route is the actual intended path regardless: it's
    // what the 48h hold in run_affiliate_payout_cycle checks against, so
    // it must reflect exactly when the change really happened.
    update.payout_method_updated_at = new Date().toISOString()

    const adminSupabase = await createAdminClient()
    const { error: updateError } = await adminSupabase
      .from('profiles')
      .update(update)
      .eq('id', user.id)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
