import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  try {
    // ── Auth: reseller or admin only ────────────────────────────────────────
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('role').eq('id', user.id).single()
    if (!['reseller', 'admin'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
    }

    // ── Payload validation ──────────────────────────────────────────────────
    const { recipient_email, gb_allocated } = await req.json()
    if (!recipient_email || !gb_allocated || gb_allocated <= 0) {
      return NextResponse.json(
        { error: 'Recipient email and a positive GB amount are required' },
        { status: 400 }
      )
    }

    const adminSupabase = await createAdminClient()

    // ── 1. Find recipient ───────────────────────────────────────────────────
    const { data: recipientProfile, error: recipientError } = await adminSupabase
      .from('profiles')
      .select('id, email, is_deleted')
      .eq('email', recipient_email.toLowerCase())
      .single()

    if (recipientError || !recipientProfile) {
      return NextResponse.json(
        { error: 'Recipient not found. They must sign up at GlobProxy first.' },
        { status: 404 }
      )
    }
    if (recipientProfile.is_deleted) {
      return NextResponse.json({ error: 'Recipient account no longer exists.' }, { status: 404 })
    }
    if (recipientProfile.id === user.id) {
      return NextResponse.json({ error: 'Cannot allocate bandwidth to yourself.' }, { status: 400 })
    }

    // ── 2 & 3. Atomically check balance, deduct, and credit the recipient ──
    // Previously this read total_gb/used_gb, computed the new value in JS,
    // then wrote it back as a separate statement — a classic check-then-act
    // race. Two concurrent allocation calls (double-click, retry, two tabs)
    // could both pass the balance check before either write landed,
    // over-allocating stock. The rollback path had its own bug too: on
    // failure it reset used_gb to the value read *before* this call, which
    // could stomp a legitimate concurrent write that happened in between.
    //
    // allocate_reseller_bandwidth() (migration 0004) does the balance check
    // and both writes inside a single locked Postgres transaction, so
    // there's no window for either problem. It also writes to the new
    // allocated_gb column instead of used_gb — used_gb is exclusively
    // consumption data owned by the usage-sync cron; overloading it with
    // "GB committed to clients" meant the cron silently erased every
    // allocation on its next run, letting resellers re-allocate the same
    // stock repeatedly.
    const { data: rpcResult, error: rpcError } = await adminSupabase
      .rpc('allocate_reseller_bandwidth', {
        p_reseller_id: user.id,
        p_recipient_id: recipientProfile.id,
        p_gb: gb_allocated,
      })

    if (rpcError) {
      const message = rpcError.message?.includes('Not enough bandwidth')
        ? 'Not enough bandwidth in your stock.'
        : rpcError.message?.includes('yourself')
        ? 'Cannot allocate bandwidth to yourself.'
        : 'Failed to complete transfer.'
      const status = rpcError.message?.includes('Not enough') || rpcError.message?.includes('yourself') ? 400 : 500
      return NextResponse.json({ error: message }, { status })
    }
    void rpcResult

    // ── 4. Record transfer history ──────────────────────────────────────────
    // Non-fatal: if this insert fails, the bandwidth transfer already succeeded.
    // Log it but don't roll back a completed transfer over a history write.
    const { error: historyError } = await adminSupabase
      .from('reseller_transfers')
      .insert({
        reseller_id: user.id,
        recipient_id: recipientProfile.id,
        gb_amount: gb_allocated,
        status: 'active',
        activated_at: new Date().toISOString(),
      })

    if (historyError) {
      console.error('Transfer history write failed (transfer itself succeeded):', historyError.message)
    }

    return NextResponse.json({
      success: true,
      message: `Successfully transferred ${gb_allocated}GB to ${recipient_email}`,
    })

  } catch (err: any) {
    console.error('Allocation error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
