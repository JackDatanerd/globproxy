import { createAdminClient } from '@/lib/supabase/server'
import { createSubUser, deleteSubUser } from '@/lib/geonode'
import { sendEmail, escapeHtml } from '@/lib/email'
import { processReferralForOrder } from '@/lib/referrals'

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
  amount_usd: number
}) {
  const supabase = await createAdminClient()

  // 1 & 2. Atomically claim the order AND credit the GB in one call — see
  // migration 0015. These used to be two separate statements: claim first
  // (guarding the UPDATE on bandwidth_credited = false so a racing webhook
  // + verify-payment call can't both credit the same order), then a
  // separate credit_bandwidth RPC. If that second call failed for any
  // reason, the claim had already committed — the order was left
  // permanently "paid" with bandwidth_credited=true and nothing actually
  // credited, and the claim guard meant no retry could ever re-enter this
  // path. claim_and_credit_order() does both inside one Postgres
  // transaction, so an error crediting rolls back the claim too, leaving
  // the order exactly as it was before this call — safe for a webhook
  // redelivery or manual re-verify to complete it cleanly.
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_and_credit_order', {
    p_order_id: p.order_id,
    p_user_id: p.user_id,
    p_gb: p.gb_amount,
    p_paystack_reference: p.paystack_reference,
  })

  if (claimErr) {
    // Nothing committed — the order is untouched and still claimable.
    // Surfaced loudly since this is the one path where staying silent
    // previously turned into a permanent, unrecoverable non-credit.
    console.error('[bandwidth] claim_and_credit_order RPC failed — order left unclaimed, safe to retry', p.order_id, claimErr)
    return
  }

  if (!claimed) {
    // Already credited by a concurrent call (or a retry) — nothing to do.
    console.log('[bandwidth] order already credited, skipping', p.order_id)
    return
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
    .select('email, full_name, referral_code')
    .eq('id', p.user_id)
    .single()

  if (profile?.email) {
    const referralLine = profile.referral_code
      ? `<p style="color:#444;text-align:center;font-size:13px;margin-top:20px;">
           Know someone who could use this? Share your link and you both get
           <strong>1GB free</strong> when they make their first purchase:
           <br/>
           <a href="${process.env.NEXT_PUBLIC_APP_URL}/auth/signup?ref=${profile.referral_code}" style="color:#2563eb;">
             ${process.env.NEXT_PUBLIC_APP_URL}/auth/signup?ref=${profile.referral_code}
           </a>
         </p>`
      : ''
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
          ${referralLine}
          <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
            © 2026 GlobProxy · Residential Proxies That Never Expire
          </p>
        </div>
      `,
    })
  }

  // 6. Referral / affiliate crediting — a pure add-on that runs only after
  // the buyer's own GB has already been claimed and credited above. Never
  // allowed to affect the response or roll anything back: see
  // processReferralForOrder's own doc comment in lib/referrals.ts.
  await processReferralForOrder(supabase, {
    user_id: p.user_id,
    order_id: p.order_id,
    amount_usd: p.amount_usd,
  })
}
