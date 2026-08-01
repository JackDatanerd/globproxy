import { createAdminClient } from '@/lib/supabase/server'
import { createSubUser, deleteSubUser } from '@/lib/geonode'
import { sendEmail, escapeHtml } from '@/lib/email'

function providerConfigured(): boolean {
  return !!(
    process.env.GEONODE_API_KEY &&
    process.env.GEONODE_RESELLER_ID
  )
}

export async function activateBandwidth(p: {
  order_id: string
  user_id: string
  gb_amount: number
  paystack_reference: string
}) {
  const supabase = await createAdminClient()

  // 1. Atomically claim the order. The webhook and /api/verify-payment can
  // both reach this function within moments of each other (Paystack fires
  // the webhook around the same time the browser redirects back). A plain
  // "check payment_status, then update" has a race window where both
  // callers pass the check before either writes 'paid', crediting bandwidth
  // twice. Guarding the UPDATE itself on bandwidth_credited = false makes
  // the claim a single atomic statement — only one caller's UPDATE can
  // match and return a row.
  const { data: claimed } = await supabase
    .from('orders')
    .update({
      payment_status: 'paid',
      paystack_reference: p.paystack_reference,
      bandwidth_credited: true,
      paid_at: new Date().toISOString(),
    })
    .eq('id', p.order_id)
    .eq('bandwidth_credited', false)
    .select('id')
    .single()

  if (!claimed) {
    // Already credited by a concurrent call (or a retry) — nothing to do.
    console.log('[bandwidth] order already credited, skipping', p.order_id)
    return
  }

  // 2. Credit GB to bandwidth account.
  // Previously this read total_gb then wrote back total_gb + gb_amount as
  // two separate calls — a lost-update race if two orders for the same
  // user got paid at nearly the same instant (e.g. two tabs, a retried
  // checkout). credit_bandwidth() (migration 0004) does the increment
  // atomically in Postgres, and creates the account row if it somehow
  // doesn't exist yet instead of silently no-op-ing.
  const { error: creditErr } = await supabase.rpc('credit_bandwidth', {
    p_user_id: p.user_id,
    p_gb: p.gb_amount,
  })
  if (creditErr) {
    console.error('[bandwidth] credit_bandwidth RPC failed', p.order_id, creditErr)
  }

  // 3. Activate pending proxy credentials — only when provider is configured
  if (providerConfigured()) {
    const { data: pending } = await supabase
      .from('proxy_credentials')
      .select('*')
      .eq('user_id', p.user_id)
      .eq('status', 'pending')
      .is('created_by', null)

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
        const { error: updateErr } = await supabase.from('proxy_credentials').update({
          status: 'active',
          geonode_sub_user_id: gcred.geonode_sub_user_id, // required for usage/delete lookups
          geonode_username: gcred.username,
          geonode_password: gcred.password,
          host: gcred.host,
          port: gcred.port,
          activated_at: new Date().toISOString(),
        }).eq('id', cred.id)

        if (updateErr) {
          // Supabase doesn't throw on this — it was failing silently before,
          // leaving a real Geonode sub-user orphaned with no local record.
          console.error('Failed to persist activated credential', cred.id, updateErr)
          await deleteSubUser(gcred.geonode_sub_user_id).catch(() => {})
        }
      } catch (e) {
        console.error('Failed to activate credential', cred.id, e)
      }
    }

    // (There used to be a step 4 here activating reseller_transfers rows
    // with status:'pending'. allocate/route.ts is the only writer of that
    // table and always inserts status:'active' with no credential_id — the
    // transfer is a direct bandwidth ledger move, not a Geonode credential
    // provisioning event, so there was never a 'pending' row for this block
    // to find. Removed as dead code; reseller_transfers activation, if it's
    // ever needed, belongs in allocate/route.ts where the row is created.)
  } else {
    console.log('[bandwidth] No provider configured — skipping credential activation for order', p.order_id)
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
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
          <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
            style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
          <h2 style="text-align:center;color:#111;">Bandwidth activated ✓</h2>
          <p style="color:#444;text-align:center;">
            Hi ${escapeHtml(profile.full_name?.split(' ')[0]) || 'there'},
            your <strong>${p.gb_amount} GB</strong> of residential proxy bandwidth
            is now in your account. It never expires — use it at your own pace.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/proxies"
               style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Create your first proxy session →
            </a>
          </div>
          <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
            © 2026 GlobProxy · Residential Proxies That Never Expire
          </p>
        </div>
      `,
    })
  }
}
