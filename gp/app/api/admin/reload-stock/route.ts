import { createAdminClient } from '@/lib/supabase/server'
import { purchaseBandwidth } from '@/lib/geonode'
import { sendEmail } from '@/lib/email'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createAdminClient()
  const { gb_amount } = await req.json()
  if (!gb_amount || gb_amount < 100)
    return NextResponse.json({ error: 'Minimum reload is 100 GB' }, { status: 400 })
  try {
    await purchaseBandwidth(gb_amount)
    await sendEmail({
      to: process.env.ADMIN_EMAIL ?? 'admin@globproxy.com',
      subject: `Stock reloaded: ${gb_amount}GB — GlobProxy`,
      html: `<p>Your bandwidth stock has been reloaded with <strong>${gb_amount} GB</strong>.</p>`,
    })
    return NextResponse.json({ success: true, gb_amount })
  } catch (err: any) {
    // purchaseBandwidth is currently disabled — Geonode's reseller API has no
    // documented purchase endpoint. See lib/geonode.ts for details.
    return NextResponse.json({ error: err.message }, { status: 501 })
  }
}
