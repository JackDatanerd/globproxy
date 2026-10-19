import { NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'

// Mirrors app/api/auth/apply-reseller/route.ts almost exactly — same
// reasons for the admin-client write (api_access_status is one of the
// columns protect_privileged_profile_columns force-resets for any
// non-admin caller, see migration 0028), same "authenticate with the
// session client, write with the admin client" split.
export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive

    const adminSupabase = await createAdminClient()
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('role, api_access, api_access_status, full_name, email')
      .eq('id', user.id)
      .single()

    // Only resellers can apply — a plain 'user' account has nothing to
    // point the API at yet (no sub-user allocation to make), and admin
    // already has access unconditionally.
    if (profile?.role !== 'reseller') {
      return NextResponse.json({ error: 'API access is available to reseller accounts.' }, { status: 403 })
    }
    if (profile.api_access) {
      return NextResponse.json({ error: 'API access is already enabled on your account.' }, { status: 409 })
    }
    if (profile.api_access_status === 'pending') {
      return NextResponse.json({ error: 'You already have a pending API access request.' }, { status: 409 })
    }

    const { use_case, website_url } = await req.json()
    if (!use_case || typeof use_case !== 'string' || use_case.trim().length < 10) {
      return NextResponse.json({ error: 'Tell us a little about what you plan to automate (at least a sentence).' }, { status: 400 })
    }
    // Optional — some integrations don't have a public-facing site (e.g.
    // an internal tool), so this isn't required the way use_case is. Light
    // validation only: catch obvious typos/junk without being a strict
    // URL-format gate that rejects a bare domain someone typed without a
    // scheme.
    let cleanedUrl: string | null = null
    if (website_url && typeof website_url === 'string' && website_url.trim()) {
      const trimmed = website_url.trim()
      if (trimmed.length > 300) {
        return NextResponse.json({ error: 'Website URL is too long.' }, { status: 400 })
      }
      cleanedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
      try { new URL(cleanedUrl) } catch {
        return NextResponse.json({ error: 'That website URL doesn\'t look right.' }, { status: 400 })
      }
    }

    const application = {
      use_case: use_case.trim(),
      website_url: cleanedUrl,
      applied_at: new Date().toISOString(),
    }

    const { error: updateError } = await adminSupabase
      .from('profiles')
      .update({
        api_access_status: 'pending',
        api_access_application: application,
      })
      .eq('id', user.id)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    const adminEmail = process.env.ADMIN_EMAIL
    if (adminEmail) {
      await sendEmail({
        to: adminEmail,
        subject: `New API access request — ${profile.full_name || profile.email}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">New API Access Request</h2>
            <table style="width:100%;border-collapse:collapse;margin:24px 0;">
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Reseller</td><td style="padding:8px 0;font-size:13px;font-weight:600;">${escapeHtml(profile.full_name) || '—'}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Email</td><td style="padding:8px 0;font-size:13px;">${escapeHtml(user.email)}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px;">Use case</td><td style="padding:8px 0;font-size:13px;">${escapeHtml(use_case.trim())}</td></tr>
              ${cleanedUrl ? `<tr><td style="padding:8px 0;color:#888;font-size:13px;">Website</td><td style="padding:8px 0;font-size:13px;"><a href="${escapeHtml(cleanedUrl)}" style="color:#2563eb;">${escapeHtml(cleanedUrl)}</a></td></tr>` : ''}
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

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[dashboard/apply-api-access] unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
