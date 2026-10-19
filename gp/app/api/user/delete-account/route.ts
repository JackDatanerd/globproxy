import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { deleteSubUser, GeonodeApiError } from '@/lib/geonode'
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
      .select('email, full_name, is_deleted, company_name, api_access, reseller_application, affiliate_application, api_access_application, payout_method, payout_wallet_address, payout_wallet_network, payout_bank_details, payout_mpesa_phone, payout_method_updated_at, mfa_enabled')
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

    // Every sub-user must really be gone before anything local changes: this
    // used to swallow failures, so an outage left live, usable proxies behind
    // an account marked deleted. 404 = already gone (a retry after a partial
    // run), which is fine — so this route is safe to call again.
    for (const cred of creds ?? []) {
      if (!cred.geonode_sub_user_id) continue
      try {
        await deleteSubUser(cred.geonode_sub_user_id)
      } catch (e) {
        if (e instanceof GeonodeApiError && e.status === 404) continue
        console.error('Failed to clean up Geonode sub-user during account deletion — aborting', cred.id, e)
        return NextResponse.json(
          { error: 'We could not remove your proxy sessions right now, so your account was not deleted. Please try again in a few minutes.' },
          { status: 502 }
        )
      }
    }

    // Step 4: Anonymise. Wipes everything personal on the profile — name,
    // email, company, payout destination (wallet / bank / M-Pesa) and the
    // free-text applications — while keeping what accounting and abuse
    // handling need: orders/invoices, ledgers and the suspension state. A
    // suspended account that deletes itself stays suspended (this used to
    // clear the suspension fields, turning self-deletion into an unsuspend).
    const { error: profileError } = await adminSupabase
      .from('profiles')
      .update({
        full_name: '[deleted]',
        email: '[deleted]',
        company_name: null,
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        api_access: false,
        reseller_application: null,
        affiliate_application: null,
        api_access_application: null,
        payout_method: null,
        payout_wallet_address: null,
        payout_wallet_network: null,
        payout_bank_details: null,
        payout_mpesa_phone: null,
        payout_method_updated_at: null,
        mfa_enabled: false,
      })
      .eq('id', user.id)

    if (profileError) {
      console.error('delete-account: profile anonymise failed', profileError)
      return NextResponse.json({ error: 'Could not delete the account. Please try again.' }, { status: 500 })
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
      // Rollback anonymisation (everything the update above cleared)
      await adminSupabase.from('profiles').update({
        full_name: profile?.full_name ?? null,
        email: profile?.email ?? null,
        company_name: profile?.company_name ?? null,
        is_deleted: false,
        deleted_at: null,
        api_access: profile?.api_access ?? false,
        reseller_application: profile?.reseller_application ?? null,
        affiliate_application: profile?.affiliate_application ?? null,
        api_access_application: profile?.api_access_application ?? null,
        payout_method: profile?.payout_method ?? null,
        payout_wallet_address: profile?.payout_wallet_address ?? null,
        payout_wallet_network: profile?.payout_wallet_network ?? null,
        payout_bank_details: profile?.payout_bank_details ?? null,
        payout_mpesa_phone: profile?.payout_mpesa_phone ?? null,
        payout_method_updated_at: profile?.payout_method_updated_at ?? null,
        mfa_enabled: profile?.mfa_enabled ?? false,
      }).eq('id', user.id)
      console.error('delete-account: ban failed', banError)
      return NextResponse.json({ error: 'Could not delete the account. Please try again.' }, { status: 500 })
    }

    // Step 6: Credentials: sub-users are gone upstream, so mark them
    // suspended (no 'deleted' status value exists) and drop the stored
    // proxy password + Geonode ids. The unique index on
    // geonode_sub_user_id (migration 0040) also stops a stale id lingering.
    if ((creds ?? []).length) {
      await adminSupabase.from('proxy_credentials')
        .update({ status: 'suspended', geonode_password: null, geonode_username: null, geonode_sub_user_id: null })
        .eq('user_id', user.id)
    }

    // Step 6a: Remove personal / secret data that has no accounting value:
    // webhook URLs + signing secrets, 2FA seeds / backup codes / trusted
    // browsers, and the email attached to support reports.
    await adminSupabase.from('webhook_endpoints').delete().eq('user_id', user.id)
    await adminSupabase.from('mfa_totp_factors').delete().eq('user_id', user.id)
    await adminSupabase.from('mfa_backup_codes').delete().eq('user_id', user.id)
    await adminSupabase.from('mfa_verified_sessions').delete().eq('user_id', user.id)
    await adminSupabase.from('support_reports').update({ email: '[deleted]' }).eq('user_id', user.id)

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
              deleted as requested. Your name, email, payout details and proxy credentials have been removed. Records of past payments are kept as required for accounting.
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
    console.error('delete-account unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
