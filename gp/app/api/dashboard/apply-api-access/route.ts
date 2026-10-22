import { requireMfaVerified } from '@/lib/mfa'
import { appUrl } from '@/lib/appUrl'
import { rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'
import { requireActiveUser, rejectCrossSite } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'

// Mirrors app/api/auth/apply-reseller/route.ts almost exactly — same
// reasons for the admin-client write (api_access_status is one of the
// columns protect_privileged_profile_columns force-resets for any
// non-admin caller, see migration 0028), same "authenticate with the
// session client, write with the admin client" split.
export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Per-user throttle (lib/rateLimit.ts) — this route emails staff on every call.
    const throttled = await rateLimitedUser('USER_EMAIL_RATE_LIMITER', user.id, 'apply-api-access')
    if (throttled) return throttled

    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive
    const mfaBlock = await requireMfaVerified(req, user.id)
    if (mfaBlock) return mfaBlock

    const adminSupabase = await createAdminClient()
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('role, api_access, api_access_status, api_access_rejected_at, api_access_application, full_name, email')
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

    // A rejected request may be re-submitted, but not immediately — every
    // submit emails an admin, so without a cooldown one account could flood
    // the inbox. Same 7 days apply-affiliate / apply-reseller use, measured
    // from the REJECTION (api_access_rejected_at, migration 0052).
    if (profile.api_access_status === 'rejected') {
      const app = (profile.api_access_application ?? {}) as { applied_at?: string }
      const since = Date.parse(profile.api_access_rejected_at ?? app.applied_at ?? '')
      if (Number.isFinite(since) && Date.now() - since < 7 * 24 * 60 * 60 * 1000) {
        return NextResponse.json({ error: 'You can re-apply 7 days after your request was reviewed.' }, { status: 429 })
      }
    }

    const body = await req.json().catch(() => ({}))
    const { use_case, website_url } = body as { use_case?: unknown; website_url?: unknown }
    if (!use_case || typeof use_case !== 'string' || use_case.trim().length < 10) {
      return NextResponse.json({ error: 'Tell us a little about what you plan to automate (at least a sentence).' }, { status: 400 })
    }
    // This lands in a jsonb column and an email to the admin — bound it.
    if (use_case.trim().length > 1200) {
      return NextResponse.json({ error: 'Please keep your description under 1200 characters.' }, { status: 400 })
    }
    // Optional — some integrations don't have a public-facing site (e.g.
    // an internal tool), so this isn't required the way use_case is. Light
    // validation only: catch obvious typos/junk without being a strict
    // URL-format gate that rejects a bare domain someone typed without a
    // scheme.
    let cleanedUrl: string | null = null
    if (typeof website_url === 'string' && website_url.trim()) {
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

    // The eligibility conditions are part of the UPDATE itself, so a
    // double-submit (or a request approved a moment ago) can't race the
    // checks above and knock an account back to 'pending'.
    const { data: updated, error: updateError } = await adminSupabase
      .from('profiles')
      .update({
        api_access_status: 'pending',
        api_access_application: application,
      })
      .eq('id', user.id)
      .eq('role', 'reseller')
      .or('api_access.is.null,api_access.eq.false')
      .or('api_access_status.is.null,api_access_status.eq.rejected')
      .select('id')

    if (updateError) {
      console.error('[dashboard/apply-api-access] update failed', updateError.message)
      return NextResponse.json({ error: 'Could not submit your request. Please try again.' }, { status: 500 })
    }
    if (!updated?.length) {
      return NextResponse.json({ error: 'You already have an API access request or access on file.' }, { status: 409 })
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
              <a href="${appUrl()}/admin/resellers"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Review in admin panel →
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © ${new Date().getFullYear()} GlobProxy · Residential Proxies That Never Expire
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
