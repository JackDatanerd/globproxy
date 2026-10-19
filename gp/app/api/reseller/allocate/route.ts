import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireMfaVerified } from '@/lib/mfa'
import { sendEmail, escapeHtml } from '@/lib/email'
import { dispatchWebhook } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  try {
    // ── Auth: reseller or admin only ────────────────────────────────────────
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('role, email, full_name').eq('id', user.id).single()
    if (!['reseller', 'admin'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
    }

    const mfaCheck = await requireMfaVerified(req, user.id)
    if (mfaCheck) return mfaCheck

    // Wasn't checked at all before — neither for the sender nor the
    // recipient below — despite is_suspended being enforced on nearly
    // every other write route. A suspended reseller could otherwise keep
    // allocating their existing stock to clients indefinitely.
    const senderSuspended = await requireActiveUser(user.id)
    if (senderSuspended) return senderSuspended

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
      .select('id, email, full_name, is_deleted, is_suspended')
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
    // Low risk either way (worst case a suspended recipient just can't use
    // the bandwidth until reinstated), but inconsistent with the
    // suspension model everywhere else if left unchecked, and it avoids a
    // reseller burning real stock on an account that can't act on it yet.
    if (recipientProfile.is_suspended) {
      return NextResponse.json({ error: 'Recipient account is currently suspended.' }, { status: 403 })
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

    // Webhook for the recipient: bandwidth landed on their account. Awaited
    // and never throws (see lib/webhooks.ts).
    await dispatchWebhook(recipientProfile.id, 'bandwidth_credited', {
      gb_credited: gb_allocated, source: 'reseller_allocation',
    })

    // Notify both sides — previously a transfer completed silently for
    // everyone: the recipient had no way to know new bandwidth had landed
    // on their account short of noticing it themselves in the dashboard,
    // and the sender had no durable confirmation beyond the toast on
    // screen at the moment of the transfer. Best-effort: the transfer
    // itself already succeeded above regardless of whether either email
    // goes out.
    const senderName = escapeHtml(profile?.full_name?.split(' ')[0]) || 'there'
    if (profile?.email) {
      await sendEmail({
        to: profile.email,
        subject: `Confirmed: ${gb_allocated}GB transferred to ${recipient_email}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Transfer confirmed ✓</h2>
            <p style="color:#444;text-align:center;">
              Hi ${senderName}, you've transferred <strong>${gb_allocated}GB</strong> to
              ${escapeHtml(recipient_email)}. It's been deducted from your available stock
              and is now active on their account.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/reseller/transfers"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                View transfer history →
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © 2026 GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
      }).catch((e) => console.error('[reseller/allocate] sender confirmation email failed:', e))
    }

    if (recipientProfile.email) {
      await sendEmail({
        to: recipientProfile.email,
        subject: `${gb_allocated}GB of bandwidth was added to your account`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Bandwidth added ✓</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(recipientProfile.full_name?.split(' ')[0]) || 'there'},
              <strong>${gb_allocated}GB</strong> has been added to your GlobProxy account by
              ${escapeHtml(profile?.full_name) || escapeHtml(user.email) || 'your reseller'}.
              It's ready to use now.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Go to dashboard →
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © 2026 GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
      }).catch((e) => console.error('[reseller/allocate] recipient notification email failed:', e))
    }

    return NextResponse.json({
      success: true,
      message: `Successfully transferred ${gb_allocated}GB to ${recipient_email}`,
    })

  } catch (err: any) {
    console.error('Allocation error:', err)
    console.error('[reseller/allocate] unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
