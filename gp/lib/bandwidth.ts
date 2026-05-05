import { createAdminClient } from '@/lib/supabase/server'
import { createSubUser } from '@/lib/geonode'
import { sendEmail } from '@/lib/email'

export async function activateBandwidth(p: {
  order_id: string
  user_id: string
  gb_amount: number
  paystack_reference: string
}) {
  const supabase = await createAdminClient()

  // 1. Mark order paid
  await supabase.from('orders').update({
    payment_status: 'paid',
    paystack_reference: p.paystack_reference,
    bandwidth_credited: true,
    paid_at: new Date().toISOString(),
  }).eq('id', p.order_id)

  // 2. Credit GB to bandwidth account
  const { data: bw } = await supabase
    .from('bandwidth_accounts')
    .select('total_gb')
    .eq('user_id', p.user_id)
    .single()

  await supabase.from('bandwidth_accounts')
    .update({ total_gb: (bw?.total_gb ?? 0) + p.gb_amount })
    .eq('user_id', p.user_id)

  // 3. Activate any pending proxy credentials for this user
  const { data: pending } = await supabase
    .from('proxy_credentials')
    .select('*')
    .eq('user_id', p.user_id)
    .eq('status', 'pending')
    .is('created_by', null) // only direct user credentials, not reseller allocations

  for (const cred of pending ?? []) {
    try {
      const gcred = await createSubUser({
        label: cred.label ?? `gp_${p.user_id.slice(0, 8)}`,
        gb_limit: cred.gb_allocated,
        country: cred.country ?? undefined,
        state: cred.state ?? undefined,
        city: cred.city ?? undefined,
        protocol: cred.protocol ?? 'http',
        session_type: cred.session_type ?? 'rotating',
        sticky_duration: cred.sticky_duration ?? undefined,
      })
      await supabase.from('proxy_credentials').update({
        status: 'active',
        geonode_username: gcred.username,
        geonode_password: gcred.password,
        host: gcred.host,
        port: gcred.port,
        activated_at: new Date().toISOString(),
      }).eq('id', cred.id)
    } catch (e) {
      console.error('Failed to activate credential', cred.id, e)
    }
  }

  // 4. Activate pending reseller transfers for this user
  // Reseller allocations: created_by is set and != user_id
  const { data: transfers } = await supabase
    .from('reseller_transfers')
    .select('*, proxy_credentials(*)')
    .eq('recipient_id', p.user_id)
    .eq('status', 'pending')

  for (const t of transfers ?? []) {
    const cred = t.proxy_credentials as any
    if (!cred) continue
    try {
      const gcred = await createSubUser({
        label: cred.label ?? `reseller_sub`,
        gb_limit: t.gb_amount,
        country: cred.country ?? undefined,
        state: cred.state ?? undefined,
        city: cred.city ?? undefined,
        protocol: cred.protocol ?? 'http',
        session_type: cred.session_type ?? 'rotating',
      })
      await supabase.from('proxy_credentials').update({
        status: 'active',
        geonode_username: gcred.username,
        geonode_password: gcred.password,
        host: gcred.host,
        port: gcred.port,
        activated_at: new Date().toISOString(),
      }).eq('id', cred.id)

      await supabase.from('reseller_transfers').update({
        status: 'active',
        activated_at: new Date().toISOString(),
      }).eq('id', t.id)
    } catch (e) {
      console.error('Failed to activate reseller transfer', t.id, e)
    }
  }

  // 5. Send confirmation email
  const { data: profile } = await supabase
    .from('profiles')
    .select('email, full_name')
    .eq('id', p.user_id)
    .single()

  if (profile?.email) {
    await sendEmail({
      to: profile.email,
      subject: `Your ${p.gb_amount}GB is ready — GlobProxy`,
      html: `
        <div style="font-family:sans-serif;max-width:520px">
          <h2 style="color:#0057ff">Bandwidth activated</h2>
          <p>Hi ${profile.full_name?.split(' ')[0] ?? 'there'},</p>
          <p>Your <strong>${p.gb_amount} GB</strong> of residential proxy bandwidth
             is now in your account. It never expires — use it at your own pace.</p>
          <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/proxies"
             style="display:inline-block;background:#0057ff;color:#fff;padding:10px 20px;
                    border-radius:8px;text-decoration:none;font-weight:500;margin-top:8px">
            Create your first proxy session →
          </a>
          <p style="color:#8892a0;font-size:12px;margin-top:20px">— GlobProxy</p>
        </div>
      `,
    })
  }
}
