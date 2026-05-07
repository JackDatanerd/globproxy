import { createAdminClient } from '@/lib/supabase/server'
import { purchaseBandwidth } from '@/lib/geonode'
import { sendEmail } from '@/lib/email'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { gb_amount } = await req.json()
  if (!gb_amount || gb_amount < 100) return NextResponse.json({ error: 'Minimum reload is 100 GB' }, { status: 400 })

  try {
    await purchaseBandwidth(gb_amount)
    await sendEmail({
      to: process.env.ADMIN_EMAIL ?? 'admin@globproxy.com',
      subject: `Stock reloaded: ${gb_amount}GB — GlobProxy`,
      html: `<p>Your Geonode stock has been reloaded with <strong>${gb_amount} GB</strong> at $${(gb_amount * 0.49).toFixed(2)}.</p><p>Check your dashboard for updated balance.</p>`,
    })
    return NextResponse.json({ success: true, gb_amount })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
