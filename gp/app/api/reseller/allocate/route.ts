import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single()
  
  if (!['reseller', 'admin'].includes(profile?.role ?? '')) {
    return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
  }

  const { recipient_email, gb_allocated } = await req.json()
  
  if (!recipient_email || !gb_allocated || gb_allocated <= 0) {
    return NextResponse.json({ error: 'recipient_email and gb_allocated are required' }, { status: 400 })
  }

  const adminSupabase = await createAdminClient()

  // 1. Fetch recipient profile by email
  const { data: recipientProfile, error: recipientError } = await adminSupabase
    .from('profiles')
    .select('id')
    .eq('email', recipient_email)
    .single()

  if (recipientError || !recipientProfile) {
    return NextResponse.json({ error: 'User not found. They must sign up at globproxy.com first before you can allocate.' }, { status: 404 })
  }

  const recipient_id = recipientProfile.id

  // 2. Fetch Reseller Bandwidth to verify stock
  const { data: resellerBw, error: rBwErr } = await adminSupabase
    .from('bandwidth_accounts')
    .select('total_gb, used_gb')
    .eq('user_id', user.id)
    .single()

  if (rBwErr || !resellerBw) {
    return NextResponse.json({ error: 'Failed to fetch your bandwidth' }, { status: 500 })
  }

  const availableGb = (resellerBw.total_gb ?? 0) - (resellerBw.used_gb ?? 0)
  if (gb_allocated > availableGb) {
    return NextResponse.json({ error: 'Not enough bandwidth in your stock' }, { status: 400 })
  }

  // 3. Perform Bandwidth Transfer Transaction
  
  // Deduct from reseller (by compounding their used_gb)
  const { error: rUpdateErr } = await adminSupabase
    .from('bandwidth_accounts')
    .update({ used_gb: (resellerBw.used_gb ?? 0) + gb_allocated })
    .eq('user_id', user.id)

  if (rUpdateErr) return NextResponse.json({ error: 'Failed to deduct from your stock' }, { status: 500 })

  // Credit recipient (by increasing their total_gb)
  const { data: recipientBw } = await adminSupabase
    .from('bandwidth_accounts')
    .select('total_gb')
    .eq('user_id', recipient_id)
    .single()

  const { error: recUpdateErr } = await adminSupabase
    .from('bandwidth_accounts')
    .update({ total_gb: (recipientBw?.total_gb ?? 0) + gb_allocated })
    .eq('user_id', recipient_id)

  if (recUpdateErr) return NextResponse.json({ error: 'Failed to credit recipient stock' }, { status: 500 })

  // 4. Log transfer history
  await adminSupabase.from('reseller_transfers').insert({
    reseller_id: user.id,
    recipient_id,
    gb_amount: gb_allocated,
    status: 'active',
    activated_at: new Date().toISOString(),
  })

  return NextResponse.json({ success: true, message: `${gb_allocated} GB transferred effectively` })
}