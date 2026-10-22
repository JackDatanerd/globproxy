import { requireMfaVerified } from '@/lib/mfa'
import { rejectCrossSite } from '@/lib/apiAuth'
import { appUrl } from '@/lib/appUrl'
import { NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'

function cleanStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  try {
    // Authenticate with the regular session client — never trust a
    // client-asserted user id for a write like this.
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive
    const mfaBlock = await requireMfaVerified(req, user.id)
    if (mfaBlock) return mfaBlock

    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', `apply:${user.id}`)
    if (limited) return limited
    const perUser = await rateLimitedUser('USER_EMAIL_RATE_LIMITER', user.id, 'apply-reseller')
    if (perUser) return perUser

    const body = await req.json().catch(() => ({}))
    const full_name = cleanStr(body.full_name, 100)
    const country = cleanStr(body.country, 80)
    const phone = cleanStr(body.phone, 30)
    const monthly_volume = cleanStr(body.monthly_volume, 80)

    if (!full_name || !country || !phone || !monthly_volume) {
      return NextResponse.json({ error: 'All fields are required' }, { status: 400 })
    }
    if (!/^[+\d][\d\s().-]{5,}$/.test(phone)) {
      return NextResponse.json({ error: 'Enter a valid phone number.' }, { status: 400 })
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

    // A rejected applicant may re-apply, but not immediately — otherwise a single
    // account can flood the admin queue and ADMIN_EMAIL inbox (each submit emails
    // an admin). 7 days is what the rejection email promises. Uses the
    // application's own timestamps; the atomic UPDATE below still decides.
    {
      const { data: prior } = await adminSupabase
        .from('profiles').select('reseller_status, reseller_application, reseller_rejected_at').eq('id', user.id).maybeSingle()
      if (prior?.reseller_status === 'rejected') {
        // reseller_rejected_at is stamped by resolvePendingApplication (migration 0051);
        // rejections from before it existed fall back to the submission time.
        const app = (prior.reseller_application ?? {}) as { applied_at?: string }
        const since = Date.parse(prior.reseller_rejected_at ?? app.applied_at ?? '')
        if (Number.isFinite(since) && Date.now() - since < 7 * 24 * 60 * 60 * 1000) {
          return NextResponse.json({ error: 'You can re-apply 7 days after your application was reviewed.' }, { status: 429 })
        }
      }
    }
    //
    // Only an ordinary account that never applied (or was rejected) may
    // (re)apply. This used to write 'pending' unconditionally, so an
    // approved or suspended reseller re-submitting the form had their
    // status regressed, and anyone could spam the admin inbox with
    // unlimited applications. The role/status guard is part of the UPDATE
    // itself so a double-submit can't race it.
    const { data: updated, error: updateError } = await adminSupabase
      .from('profiles')
      .update({
        reseller_status: 'pending',
        reseller_application: application,
      })
      .eq('id', user.id)
      .eq('role', 'user')
      .or('reseller_status.is.null,reseller_status.eq.rejected')
      .select('id')

    if (updateError) {
      console.error('[auth/apply-reseller] update failed', updateError.message)
      return NextResponse.json({ error: 'Could not submit your application. Please try again.' }, { status: 500 })
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: 'You already have a reseller application or account on file. Contact support if something looks wrong.' },
        { status: 409 }
      )
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

    return NextResponse.json({ success: true, message: 'Application submitted successfully' })

  } catch (err: any) {
    console.error('[auth/apply-reseller] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
