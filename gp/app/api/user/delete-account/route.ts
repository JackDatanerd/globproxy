import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email'

export async function DELETE(req: Request) {
  try {
    // ── 1. Verify requesting user ─────────────────────────────────────────
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const adminSupabase = await createAdminClient()

    // ── 2. Fetch profile before we wipe it (need email for the goodbye mail) ──
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('email, full_name, is_deleted')
      .eq('id', user.id)
      .single()

    if (profile?.is_deleted) {
      return NextResponse.json({ error: 'Account already deleted.' }, { status: 400 })
    }

    // ── 3. Anonymise profile — DO NOT delete it ───────────────────────────
    // The row must stay as an anchor so orders, bandwidth_accounts, and
    // reseller_transfers remain intact for auditing and dispute resolution.
    const { error: profileError } = await adminSupabase
      .from('profiles')
      .update({
        full_name: '[deleted]',
        email: '[deleted]',
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        avatar_url: null,
        is_suspended: false,
        suspended_at: null,
        suspension_reason: null,
      })
      .eq('id', user.id)

    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 500 })
    }

    // ── 4. Delete auth user ───────────────────────────────────────────────
    // proxy_credentials cascade automatically (per migration).
    // bandwidth_accounts, orders, reseller_transfers are intentionally kept.
    const { error: deleteError } = await adminSupabase.auth.admin.deleteUser(user.id)

    if (deleteError) {
      // Roll back anonymisation so account isn't stuck in a broken state
      await adminSupabase
        .from('profiles')
        .update({
          full_name: profile?.full_name ?? null,
          email: profile?.email ?? null,
          is_deleted: false,
          deleted_at: null,
        })
        .eq('id', user.id)

      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    // ── 5. Send goodbye email (best-effort — non-fatal) ───────────────────
    if (profile?.email && profile.email !== '[deleted]') {
      await sendEmail({
        to: profile.email,
        subject: 'Your GlobProxy account has been deleted',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Account deleted</h2>
            <p style="color:#444;text-align:center;">
              Hi ${profile.full_name ?? 'there'}, your GlobProxy account has been permanently deleted
              as requested. Your personal data has been removed from our system.
            </p>
            <p style="color:#444;text-align:center;">
              If you did not request this, please contact us immediately.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="mailto:support@globproxy.com"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Contact support →
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © 2026 GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
      }).catch(() => {
        // Email failure is non-fatal — deletion already succeeded
      })
    }

    return NextResponse.json({ success: true, message: 'Account deleted' })

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
