import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { deleteSubUser } from '@/lib/geonode'
import { sendEmail, escapeHtml } from '@/lib/email'
import { requireMfaVerified } from '@/lib/mfa'

export async function DELETE(req: Request) {
  try {
    // Step 1: Verify requesting user
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 2FA step-up — account deletion is irreversible, so an enrolled account
    // needs a verified session, not just a password. See lib/mfa.ts.
    const mfaGate = await requireMfaVerified(req, user.id)
    if (mfaGate) return mfaGate

    const adminSupabase = await createAdminClient()

    // Step 2: Fetch profile before wiping it
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('email, full_name, is_deleted')
      .eq('id', user.id)
      .single()

    if (profile?.is_deleted) {
      return NextResponse.json({ error: 'Account already deleted.' }, { status: 400 })
    }

    // Step 3: Clean up live Geonode sub-users before touching local rows —
    // see app/api/admin/delete-user/route.ts for the full rationale (cascade
    // from auth.users would otherwise wipe proxy_credentials with no record
    // of which Geonode sub-users need cleanup).
    const { data: creds } = await adminSupabase
      .from('proxy_credentials')
      .select('id, geonode_sub_user_id')
      .eq('user_id', user.id)
      .not('geonode_sub_user_id', 'is', null)

    for (const cred of creds ?? []) {
      if (!cred.geonode_sub_user_id) continue
      await deleteSubUser(cred.geonode_sub_user_id).catch((e) =>
        console.error('Failed to clean up Geonode sub-user during account deletion', cred.id, e)
      )
    }

    // Step 4: Anonymise — only columns confirmed to exist in profiles
    const { error: profileError } = await adminSupabase
      .from('profiles')
      .update({
        full_name: '[deleted]',
        email: '[deleted]',
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        is_suspended: false,
        suspended_at: null,
        suspension_reason: null,
      })
      .eq('id', user.id)

    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 500 })
    }

    // Step 5: Ban rather than delete the auth account — deleting it would
    // cascade and remove the anonymised profile row (and everything hanging
    // off it) we just wrote, and throw an FK error for accounts with
    // reseller_transfers history. See admin/delete-user/route.ts.
    //
    // The ban blocks future sign-ins and refreshes, but an access token
    // issued moments before this runs is a stateless JWT — Supabase has no
    // API to revoke one before it naturally expires (only refresh tokens
    // can be revoked, and only via that token owner's own JWT, which
    // isn't something either this route or admin/delete-user/route.ts
    // holds for arbitrary calls). middleware.ts's is_deleted check
    // (migration 0029) is what actually closes that window: it blocks
    // /dashboard, /reseller, /admin, and /invoice for this profile on the
    // very next request regardless of whether the access token itself is
    // technically still "valid".
    const { error: banError } = await adminSupabase.auth.admin.updateUserById(user.id, {
      ban_duration: '876000h',
    })

    if (banError) {
      // Rollback anonymisation
      await adminSupabase.from('profiles').update({
        full_name: profile?.full_name ?? null,
        email: profile?.email ?? null,
        is_deleted: false,
        deleted_at: null,
      }).eq('id', user.id)
      return NextResponse.json({ error: banError.message }, { status: 500 })
    }

    // Step 6: Mark remaining credentials suspended (no 'deleted' status value exists)
    if ((creds ?? []).length) {
      await adminSupabase.from('proxy_credentials')
        .update({ status: 'suspended' })
        .eq('user_id', user.id)
    }

    // Step 6b: Revoke any outstanding API keys and disable webhooks —
    // neither was ever touched by deletion before this. A live key kept
    // authenticating every v1 route indefinitely with no separate
    // expiry/edge-case needed (see lib/apiAuth.ts / migration 0030); a
    // still-enabled webhook is lower-risk (nothing left to trigger it
    // once credentials above are suspended) but shouldn't be left
    // looking active on a deleted account either.
    await adminSupabase.from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('revoked_at', null)
    await adminSupabase.from('webhook_endpoints')
      .update({ enabled: false })
      .eq('user_id', user.id)
      .eq('enabled', true)

    // Step 7: Email — best-effort, non-fatal
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
              Hi ${escapeHtml(profile.full_name) || 'there'}, your GlobProxy account has been permanently
              deleted as requested. Your personal data has been removed from our system.
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
      }).catch(() => {})
    }

    return NextResponse.json({ success: true, message: 'Account deleted' })

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
