import { createAdminClient } from '@/lib/supabase/server'
import { requireMfaVerified } from '@/lib/mfa'
import { sendEmail, escapeHtml } from '@/lib/email'
import { NextResponse } from 'next/server'

// Handles the role-change and API-access actions from AdminUserControls.tsx
// ("Make reseller", "Make regular user", "Grant/Revoke API access").
// Previously these wrote straight to `profiles` from the browser with no
// server-side route at all — functionally fine given RLS, but with no
// audit point and no consistent place to add side effects (e.g. killing
// sessions on a role downgrade) the way suspend-user already does.
export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: { user: caller } } = await supabase.auth.getUser(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: cp } = await supabase.from('profiles').select('role').eq('id', caller.id).single()
  if (cp?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const mfaCheck = await requireMfaVerified(req, caller.id)
  if (mfaCheck) return mfaCheck

  const { user_id, action } = await req.json() as {
    user_id?: string
    action?: 'make_reseller' | 'make_user' | 'toggle_api_access'
  }
  if (!user_id || !action) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })

  const { data: target } = await supabase.from('profiles').select('role, api_access, email, full_name').eq('id', user_id).single()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'admin') return NextResponse.json({ error: 'Cannot modify an admin account' }, { status: 403 })

  let updates: Record<string, any>
  switch (action) {
    case 'make_reseller':
      updates = { role: 'reseller', reseller_status: 'approved' }
      break
    case 'make_user':
      // Also clear reseller_status so a demoted account doesn't sit around
      // with a stale 'approved' status that no longer means anything.
      updates = { role: 'user', reseller_status: null }
      break
    case 'toggle_api_access':
      // Keep api_access_status in sync when access is granted/revoked this
      // way (the quick per-user toggle in /admin/users), not just when it
      // goes through the applicant queue on /admin/resellers — otherwise a
      // reseller granted access here would still show as "not requested"
      // on their own /dashboard/api-keys page, and revoking here wouldn't
      // clear a stale 'approved' status.
      updates = {
        api_access: !target.api_access,
        api_access_status: !target.api_access ? 'approved' : null,
      }
      break
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  const { error } = await supabase.from('profiles').update(updates).eq('id', user_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Previously none of these three actions sent any notification at all —
  // approve-reseller/reject-reseller/approve-api-access/reject-api-access
  // (the applicant-queue routes) already did, but this direct admin
  // shortcut (bypassing an application entirely) silently changed access
  // with nothing telling the account owner it happened. Best-effort: the
  // access change itself already succeeded above regardless of whether
  // the email goes out.
  if (target.email) {
    const firstName = escapeHtml(target.full_name?.split(' ')[0]) || 'there'
    let subject: string | null = null
    let heading = ''
    let body = ''
    let cta: { href: string; label: string } | null = null

    if (action === 'make_reseller') {
      subject = "You're now a GlobProxy reseller"
      heading = "You're now a reseller ✓"
      body = `Hi ${firstName}, your account has been switched to a reseller account. You can now buy wholesale bandwidth and allocate it to your own clients under your own brand.`
      cta = { href: `${process.env.NEXT_PUBLIC_APP_URL}/reseller`, label: 'Go to reseller dashboard →' }
    } else if (action === 'make_user') {
      subject = 'Your GlobProxy reseller status has been removed'
      heading = 'Reseller status removed'
      body = `Hi ${firstName}, your account is no longer a reseller account — it's back to a regular customer account. Any bandwidth you'd already allocated to clients is unaffected. If this wasn't expected, contact support.`
      cta = { href: 'mailto:support@globproxy.com', label: 'Contact support →' }
    } else if (action === 'toggle_api_access') {
      const nowEnabled = updates.api_access
      subject = nowEnabled ? 'API access has been enabled on your GlobProxy account' : 'API access has been disabled on your GlobProxy account'
      heading = nowEnabled ? 'API access enabled ✓' : 'API access disabled'
      body = nowEnabled
        ? `Hi ${firstName}, API access has been enabled on your account. Generate a key from API Keys in your dashboard to get started.`
        : `Hi ${firstName}, API access has been disabled on your account. Any existing keys stop working immediately. If this wasn't expected, contact support.`
      cta = nowEnabled
        ? { href: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/api-keys`, label: 'Go to API Keys →' }
        : { href: 'mailto:support@globproxy.com', label: 'Contact support →' }
    }

    if (subject) {
      await sendEmail({
        to: target.email,
        subject,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">${heading}</h2>
            <p style="color:#444;text-align:center;">${body}</p>
            ${cta ? `
            <div style="text-align:center;margin:32px 0;">
              <a href="${cta.href}"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                ${cta.label}
              </a>
            </div>` : ''}
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © 2026 GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
      }).catch((e) => console.error('[update-user] notification email failed:', e))
    }
  }

  // Previously tried to kill the target's session here via
  // auth.admin.signOut(user_id, 'others') — same bug as suspend-user had:
  // signOut() takes a session JWT, not a user_id (see auth-js's own type
  // signature), so this always failed silently and did nothing. Unlike
  // suspend-user, this isn't a ban — the user should still be able to log
  // in as whatever they now are — so ban_duration isn't the right fix
  // here. Turns out no fix is needed: every authorization check in this
  // app (RLS policies, requireApiAccess, every admin/*  route) reads
  // role/api_access/is_suspended fresh from `profiles` per request rather
  // than trusting a JWT claim, so a downgraded user's still-live session
  // is already fully constrained by the new values the moment this
  // update() above commits — there's nothing a stale token lets them do
  // that the fresh DB read wouldn't already block.

  return NextResponse.json({ success: true, updates })
}
