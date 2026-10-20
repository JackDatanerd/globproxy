import { appUrl } from '@/lib/appUrl'
import { createAdminClient } from '@/lib/supabase/server'
import { provisionPendingCredentials } from '@/lib/credentials'
import { dispatchWebhook } from '@/lib/webhooks'
import { sendEmail, escapeHtml } from '@/lib/email'
import { processReferralForOrder, REFERRAL_GB_BONUS, REFERRAL_MIN_ORDER_USD } from '@/lib/referrals'

export type ActivateResult =
  | { status: 'credited' }
  | { status: 'already_credited' } // nothing to do: credited earlier, refunded, or not claimable
  | { status: 'error'; error: string } // nothing committed — safe to retry

// Callers must act on the result: 'error' means the order is still
// uncredited (the claim rolled back), so the webhook answers non-200 to get
// redelivery and verify-payment tells the user it's still being processed.
// Everything after the claim is best-effort and can never turn a committed
// credit into an error.
export async function activateBandwidth(p: {
  order_id: string
  user_id: string
  gb_amount: number
  paystack_reference: string
  amount_usd: number
  is_canary?: boolean
}): Promise<ActivateResult> {
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
    return { status: 'error', error: claimErr.message ?? 'claim_and_credit_order failed' }
  }

  if (!claimed) {
    // Already credited by a concurrent call (or a retry) — nothing to do.
    console.log('[bandwidth] order already credited, skipping', p.order_id)
    return { status: 'already_credited' }
  }

  // The GB is credited and committed. Nothing below may throw out of this
  // function — a failed follow-up must not make the caller believe the
  // credit itself failed.
  //
  // The follow-ups (activating pending credentials, referral / affiliate
  // crediting) used to run exactly once, here, and were never retried: a
  // Geonode blip or DB error at this moment meant a referrer was never paid
  // or a credential never provisioned, with nothing to notice. Now the order
  // is stamped post_credit_done_at only when they succeed, and the reconcile
  // cron re-runs them for orders still unstamped (see retryPostCredit).
  // Both are idempotent. The confirmation email is attempted once, here only.
  // bandwidth_credited webhook: fired exactly once, here — not from
  // postCreditSteps, which the reconcile cron re-runs and would re-send.
  // The synthetic canary charge is never a customer event.
  if (!p.is_canary) {
    try {
      await dispatchWebhook(p.user_id, 'bandwidth_credited', {
        order_id: p.order_id, gb_credited: p.gb_amount, amount_usd: p.amount_usd, source: 'purchase',
      })
    } catch (e) {
      console.error('[bandwidth] bandwidth_credited webhook failed (credit is committed)', p.order_id, e)
    }
  }

  let done = false
  try {
    done = await postCreditSteps(supabase, p, { sendConfirmation: true })
  } catch (e) {
    console.error('[bandwidth] post-credit steps threw (credit itself is committed)', p.order_id, e)
  }
  if (done || p.is_canary) await markPostCreditDone(supabase, p.order_id)
  return { status: 'credited' }
}

async function markPostCreditDone(supabase: Awaited<ReturnType<typeof createAdminClient>>, orderId: string) {
  const { error } = await supabase.from('orders')
    .update({ post_credit_done_at: new Date().toISOString() })
    .eq('id', orderId)
    .is('post_credit_done_at', null)
  if (error) console.error('[bandwidth] could not stamp post_credit_done_at', orderId, error)
}

// Re-runs the idempotent follow-ups of an already-credited order. Called by
// the reconcile cron for orders whose first attempt didn't fully succeed.
export async function retryPostCredit(order: {
  id: string; user_id: string; gb_amount: number; amount_usd: number; is_canary?: boolean | null
}): Promise<boolean> {
  const supabase = await createAdminClient()
  let done = false
  try {
    done = await postCreditSteps(supabase, {
      order_id: order.id, user_id: order.user_id, gb_amount: Number(order.gb_amount),
      amount_usd: Number(order.amount_usd), is_canary: !!order.is_canary,
    }, { sendConfirmation: false })
  } catch (e) {
    console.error('[bandwidth] post-credit retry threw', order.id, e)
  }
  if (done) await markPostCreditDone(supabase, order.id)
  return done
}

// Provisions a real Geonode sub-user for every pending credential a user
// owns. Returns false if any could not be activated (safe to call again).
// The claim / persist / orphan-cleanup logic lives in lib/credentials.ts
// (provisionPendingCredentials): an atomic claim (claim_pending_credentials,
// migration 0042) means this purchase path, the 5-minute 'provision' cron
// task and any concurrent run can never both provision a sub-user for the
// same credential, and the conditional status='pending' write + cleanup of a
// lost race is the same one this function used to carry. ignoreBackoff: a
// purchase is a good moment to retry immediately.
export async function activatePendingCredentials(
  _supabase: Awaited<ReturnType<typeof createAdminClient>>,
  userId: string,
): Promise<boolean> {
  const r = await provisionPendingCredentials({ userId, limit: 10, ignoreBackoff: true })
  if (r.skipped) console.log('[bandwidth] credential activation skipped:', r.skipped, 'user', userId)
  return r.failed === 0
}

async function postCreditSteps(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  p: { order_id: string; user_id: string; gb_amount: number; amount_usd: number; is_canary?: boolean },
  opts: { sendConfirmation: boolean },
): Promise<boolean> {
  let ok = true

  // 3. Activate pending proxy credentials
  try {
    if (!(await activatePendingCredentials(supabase, p.user_id))) ok = false
  } catch (e) {
    ok = false
    console.error('[bandwidth] credential activation failed (credit is committed)', p.order_id, e)
  }

  // 5. Confirmation email — first attempt only, never retried (a duplicate
  // "your GB is ready" is worse than a missed one).
  if (opts.sendConfirmation) {
    try {
      await sendConfirmationEmail(supabase, p)
    } catch (e) {
      console.error('[bandwidth] confirmation email failed (credit is committed)', p.order_id, e)
    }
  }

  // 6. Referral / affiliate crediting — idempotent per order. The daily
  // canary test charge is synthetic: never a referral/affiliate event.
  if (!p.is_canary) {
    try {
      const referralOk = await processReferralForOrder(supabase, {
        user_id: p.user_id,
        order_id: p.order_id,
        amount_usd: p.amount_usd,
      })
      if (!referralOk) ok = false
    } catch (e) {
      ok = false
      console.error('[bandwidth] referral processing failed (credit is committed)', p.order_id, e)
    }
  }
  return ok
}

async function sendConfirmationEmail(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  p: { order_id: string; user_id: string; gb_amount: number; amount_usd: number; is_canary?: boolean },
) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('email, full_name, referral_code, affiliate_status')
    .eq('id', p.user_id)
    .single()

  if (profile?.email && !p.is_canary) {
    // Receipt details: the invoice number was assigned inside the atomic claim
    // that just committed, so it is readable now. Best-effort — the email
    // still goes out (without the invoice line) if this lookup fails.
    const { data: orderRow } = await supabase
      .from('orders').select('invoice_number, pay_currency, pay_amount').eq('id', p.order_id).maybeSingle()
    const invoiceNo = orderRow?.invoice_number ?? null
    const chargedLine = orderRow?.pay_currency && orderRow.pay_currency !== 'USD' && orderRow.pay_amount != null
      ? `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">Charged via M-Pesa</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;">${escapeHtml(orderRow.pay_currency)} ${Number(orderRow.pay_amount).toLocaleString('en-KE')}</td></tr>`
      : ''
    const receiptBlock = `
          <table style="width:100%;border-collapse:collapse;margin:24px 0;font-size:14px;color:#333;">
            <tr><td style="padding:6px 0;border-bottom:1px solid #eee;">Bandwidth</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;">${p.gb_amount} GB</td></tr>
            <tr><td style="padding:6px 0;border-bottom:1px solid #eee;">Amount paid</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;">$${Number(p.amount_usd).toFixed(2)} USD</td></tr>
            ${chargedLine}
            ${invoiceNo ? `<tr><td style="padding:6px 0;">Invoice</td><td style="padding:6px 0;text-align:right;"><a href="${appUrl()}/invoice/${p.order_id}" style="color:#2563eb;">${escapeHtml(invoiceNo)}</a></td></tr>` : ''}
          </table>`
    // Approved affiliates earn cash, not GB — promising them (or the people
    // they refer) "1GB free" was simply untrue.
    const refLink = `${appUrl()}/r/${profile.referral_code}`
    const referralLine = profile.referral_code
      ? `<p style="color:#444;text-align:center;font-size:13px;margin-top:20px;">
           ${profile.affiliate_status === 'approved'
             ? 'Know someone who could use this? Share your affiliate link and earn commission on their orders:'
             : `Know someone who could use this? Share your link and you both get <strong>${REFERRAL_GB_BONUS}GB free</strong> when they make their first purchase of $${REFERRAL_MIN_ORDER_USD}+:`}
           <br/>
           <a href="${refLink}" style="color:#2563eb;">${refLink}</a>
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
          ${receiptBlock}
          <div style="text-align:center;margin:32px 0;">
            <a href="${appUrl()}/dashboard/proxies"
               style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Create your first proxy session →
            </a>
          </div>
          ${referralLine}
          <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
            © ${new Date().getUTCFullYear()} GlobProxy · Residential Proxies That Never Expire
          </p>
        </div>
      `,
    })
  }
}
