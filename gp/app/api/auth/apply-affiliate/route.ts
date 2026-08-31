import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'

export async function POST(req: Request) {
  try {
    // Authenticate with the regular session client — never trust a
    // client-asserted user id for a write like this.
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { channel, audience, plan } = await req.json()

    if (!channel || !audience || !plan) {
      return NextResponse.json({ error: 'All fields are required' }, { status: 400 })
    }

    const application = {
      channel,   // e.g. "BlackHatWorld", "YouTube", "Blog/SEO", "Discord community"
      audience,  // rough size/description of who they reach
      plan,      // how they intend to promote GlobProxy
      applied_at: new Date().toISOString(),
    }

    // affiliate_status is one of the columns protect_privileged_profile_columns
    // (see migration 0031) force-resets to its old value for any non-admin
    // caller — this write must go through the admin client, same reasoning
    // as apply-reseller/route.ts. The user was already authenticated above
    // via their own session; only the write itself needs elevated
    // privileges, and it's scoped to exactly this user's row with a
    // hardcoded value ('pending'), so there's no escalation risk here.
    const adminSupabase = await createAdminClient()
    const { error: updateError } = await adminSupabase
      .from('profiles')
      .update({
        affiliate_status: 'pending',
        affiliate_application: application,
      })
      .eq('id', user.id)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // Notify admin — best-effort, non-fatal
    const adminEmail = process.env.ADMIN_EMAIL
    if (adminEmail) {
      await sendEmail({
        to: adminEmail,
        subject: `New affiliate application — ${channel}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">New Affiliate Application</h2>
            <table style="width:100%;border-collapse:collapse;margin:24px 0;">
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Email</td><td style="padding:8px 0;font-size:13px;">${escapeHtml(user.email)}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Channel</td><td style="padding:8px 0;font-size:13px;font-weight:600;">${escapeHtml(channel)}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Audience</td><td style="padding:8px 0;font-size:13px;">${escapeHtml(audience)}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Plan</td><td style="padding:8px 0;font-size:13px;">${escapeHtml(plan)}</td></tr>
            </table>
            <div style="text-align:center;margin:32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/affiliates"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Review in admin panel →
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © 2026 GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
      }).catch(() => {})
    }

    return NextResponse.json({ success: true, message: 'Application submitted successfully' })

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
