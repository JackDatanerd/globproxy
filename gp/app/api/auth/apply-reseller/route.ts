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

    const { full_name, country, phone, monthly_volume } = await req.json()

    if (!full_name || !country || !phone || !monthly_volume) {
      return NextResponse.json({ error: 'All fields are required' }, { status: 400 })
    }

    const application = {
      full_name,
      country,
      phone,
      monthly_volume,
      applied_at: new Date().toISOString(),
    }

    // reseller_status is one of the columns protect_privileged_profile_columns
    // (schema.sql) force-resets to its old value for any non-admin caller —
    // so this write must go through the admin client. The user was already
    // authenticated above via their own session; only the write itself needs
    // elevated privileges, and it's scoped to exactly this user's row with a
    // hardcoded value ('pending'), so there's no escalation risk in doing it
    // this way. Using the session client here silently no-ops the status
    // column: no error, no applicant ever shows up in /admin/resellers.
    const adminSupabase = await createAdminClient()
    const { error: updateError } = await adminSupabase
      .from('profiles')
      .update({
        reseller_status: 'pending',
        reseller_application: application,
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
        subject: `New reseller application — ${full_name}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">New Reseller Application</h2>
            <table style="width:100%;border-collapse:collapse;margin:24px 0;">
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Name</td><td style="padding:8px 0;font-size:13px;font-weight:600;">${escapeHtml(full_name)}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Email</td><td style="padding:8px 0;font-size:13px;">${escapeHtml(user.email)}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Country</td><td style="padding:8px 0;font-size:13px;">${escapeHtml(country)}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Phone</td><td style="padding:8px 0;font-size:13px;">${escapeHtml(phone)}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Monthly volume</td><td style="padding:8px 0;font-size:13px;">${escapeHtml(monthly_volume)}</td></tr>
            </table>
            <div style="text-align:center;margin:32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/resellers"
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
