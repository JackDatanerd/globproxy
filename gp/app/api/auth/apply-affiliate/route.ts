import { requireMfaVerified } from '@/lib/mfa'
import { rejectCrossSite } from '@/lib/apiAuth'
import { appUrl } from '@/lib/appUrl'
import { NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { rateLimited } from '@/lib/rateLimit'

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

    const body = await req.json().catch(() => ({}))
    // Bounded, trimmed strings only — these end up in a jsonb column AND in
    // an email to the admin, so unbounded input was a storage / inbox-
    // flooding lever for any signed-up account.
    const channel = cleanStr(body.channel, 120)
    const audience = cleanStr(body.audience, 600)
    const plan = cleanStr(body.plan, 1200)

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

    // A rejected applicant may re-apply, but not immediately — otherwise a single
    // account can flood the admin queue and ADMIN_EMAIL inbox (each submit emails
    // an admin). 7 days is what the rejection email promises. Uses the
    // application's own timestamps; the atomic UPDATE below still decides.
    {
      const { data: prior } = await adminSupabase
        .from('profiles').select('affiliate_status, affiliate_application, affiliate_rejected_at').eq('id', user.id).maybeSingle()
      if (prior?.affiliate_status === 'rejected') {
        // affiliate_rejected_at is stamped by resolvePendingApplication (migration 0051);
        // rejections from before it existed fall back to the submission time.
        const app = (prior.affiliate_application ?? {}) as { applied_at?: string }
        const since = Date.parse(prior.affiliate_rejected_at ?? app.applied_at ?? '')
        if (Number.isFinite(since) && Date.now() - since < 7 * 24 * 60 * 60 * 1000) {
          return NextResponse.json({ error: 'You can re-apply 7 days after your application was reviewed.' }, { status: 429 })
        }
      }
    }
    //
    // Only a never-applied or previously REJECTED account may (re)apply.
    // This used to write 'pending' unconditionally, so an APPROVED affiliate
    // (or Verified Operator) who re-submitted the form was silently knocked
    // back to 'pending' — and commissions only credit while affiliate_status
    // = 'approved', so their earnings stopped until an admin noticed. It also
    // let a suspended affiliate regress themselves to 'pending'. The
    // condition is part of the UPDATE itself so a double-submit can't race it.
    const { data: updated, error: updateError } = await adminSupabase
      .from('profiles')
      .update({
        affiliate_status: 'pending',
        affiliate_application: application,
      })
      .eq('id', user.id)
      .or('affiliate_status.is.null,affiliate_status.eq.rejected')
      .select('id')

    if (updateError) {
      console.error('[auth/apply-affiliate] update failed', updateError.message)
      return NextResponse.json({ error: 'Could not submit your application. Please try again.' }, { status: 500 })
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: 'You already have an affiliate application or account on file. Contact support if something looks wrong.' },
        { status: 409 }
      )
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
              <a href="${appUrl()}/admin/affiliates"
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
    console.error('[auth/apply-affiliate] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
