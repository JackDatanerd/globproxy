import { createAdminClient } from '@/lib/supabase/server'
import { createSubUser } from '@/lib/geonode'
import { sendEmail } from '@/lib/email'

export async function activateBandwidth(p: { order_id: string; user_id: string; gb_amount: number; paystack_reference: string }) {
  const supabase = await createAdminClient()

  // 1. Mark order paid
  await supabase.from('orders').update({
    payment_status: 'paid',
    paystack_reference: p.paystack_reference,
    bandwidth_credited: true,
    paid_at: new Date().toISOString()
  }).eq('id', p.order_id)

  // 2. Credit GB — upsert in case row doesn't exist yet
  const { data: bw } = await supabase
    .from('bandwidth_accounts')
    .select('total_gb')
    .eq('user_id', p.user_id)
    .single()

  await supabase.from('bandwidth_accounts').upsert({
    user_id: p.user_id,
    total_gb: (bw?.total_gb ?? 0) + p.gb_amount,
  }, { onConflict: 'user_id' })

  // 3. Activate pending proxy credentials
  const { data: pending } = await supabase
    .from('proxy_credentials')
    .select('*')
    .eq('user_id', p.user_id)
    .eq('status', 'pending')

  for (const cred of pending ?? []) {
    try {
      const g = await createSubUser({
        label: cred.label ?? `gp_${p.user_id.slice(0, 8)}`,
        gb_limit: cred.gb_allocated,
        country: cred.country,
        city: cred.city
      })
      await supabase.from('proxy_credentials').update({
        status: 'active',
        geonode_username: g.username,
        geonode_password: g.password,
        host: g.host,
        port: g.port,
        activated_at: new Date().toISOString()
      }).eq('id', cred.id)
    } catch (e) {
      console.error('Cred activation failed', cred.id, e)
    }
  }

  // 4. Activate pending reseller transfers
  const { data: transfers } = await supabase
    .from('reseller_transfers')
    .select('*, proxy_credentials(*)')
    .eq('recipient_id', p.user_id)
    .eq('status', 'pending')

  for (const t of transfers ?? []) {
    const cred = t.proxy_credentials as any
    if (!cred) continue
    try {
      const g = await createSubUser({
        label: cred.label ?? `reseller_sub`,
        gb_limit: t.gb_amount,
        country: cred.country,
        city: cred.city
      })
      await supabase.from('proxy_credentials').update({
        status: 'active',
        geonode_username: g.username,
        geonode_password: g.password,
        host: g.host,
        port: g.port,
        activated_at: new Date().toISOString()
      }).eq('id', cred.id)
      await supabase.from('reseller_transfers').update({
        status: 'active',
        activated_at: new Date().toISOString()
      }).eq('id', t.id)
    } catch (e) {
      console.error('Transfer activation failed', t.id, e)
    }
  }

  // 5. Confirmation email
  const { data: profile } = await supabase
    .from('profiles')
    .select('email, full_name')
    .eq('id', p.user_id)
    .single()

  if (profile?.email) {
    await sendEmail({
      to: profile.email,
      subject: `Your ${p.gb_amount} GB is ready — GlobProxy`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
          <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
            style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
          <h2 style="text-align:center;color:#111;">Your bandwidth is ready 🎉</h2>
          <p style="color:#444;text-align:center;">
            Hi ${profile.full_name ?? 'there'}, your <strong>${p.gb_amount} GB</strong> of
            residential proxy bandwidth is now in your account. It never expires.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard"
               style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Go to dashboard →
            </a>
          </div>
          <p style="color:#888;font-size:13px;text-align:center;">
            Questions? Reply to this email or contact support@globproxy.com
          </p>
          <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
            © 2026 GlobProxy · Residential Proxies That Never Expire
          </p>
        </div>
      `,
    })
  }
}