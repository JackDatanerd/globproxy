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
      .eq('email', recipient_email)
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

    // ── 2. Check reseller's available bandwidth ─────────────────────────────
    const { data: resellerBw, error: rBwError } = await adminSupabase
      .from('bandwidth_accounts')
      .select('id, total_gb, used_gb')
      .eq('user_id', user.id)
      .single()

    if (rBwError || !resellerBw) {
      return NextResponse.json({ error: 'Reseller bandwidth account not found.' }, { status: 404 })
    }

    const available = (resellerBw.total_gb ?? 0) - (resellerBw.used_gb ?? 0)
    if (available < gb_allocated) {
      return NextResponse.json({ error: 'Not enough bandwidth in your stock.' }, { status: 400 })
    }

    // ── 3. Atomic transfer with rollback ────────────────────────────────────
    // Step A: Deduct from reseller
    const newResellerUsed = (resellerBw.used_gb ?? 0) + gb_allocated
    const { error: deductError } = await adminSupabase
      .from('bandwidth_accounts')
      .update({ used_gb: newResellerUsed })
      .eq('id', resellerBw.id)

    if (deductError) {
      return NextResponse.json({ error: 'Failed to deduct from reseller account.' }, { status: 500 })
    }

    // Step B: Credit recipient — rollback A if this fails
    const { data: recipientBw, error: recipBwError } = await adminSupabase
      .from('bandwidth_accounts')
      .select('id, total_gb')
      .eq('user_id', recipientProfile.id)
      .single()

    let creditError: any = null

    if (!recipBwError && recipientBw) {
      // Recipient already has an account — top it up
      const { error } = await adminSupabase
        .from('bandwidth_accounts')
        .update({ total_gb: (recipientBw.total_gb ?? 0) + gb_allocated })
        .eq('id', recipientBw.id)
      creditError = error
    } else {
      // First allocation for this recipient — create account
      const { error } = await adminSupabase
        .from('bandwidth_accounts')
        .insert({ user_id: recipientProfile.id, total_gb: gb_allocated, used_gb: 0 })
      creditError = error
    }

    if (creditError) {
      // ── Rollback Step A ──
      await adminSupabase
        .from('bandwidth_accounts')
        .update({ used_gb: resellerBw.used_gb })
        .eq('id', resellerBw.id)

      return NextResponse.json(
        { error: 'Failed to credit recipient. Transfer has been rolled back.' },
        { status: 500 }
      )
    }

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
