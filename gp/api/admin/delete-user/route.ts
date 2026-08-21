import { createAdminClient } from '@/lib/supabase/server'
import { deleteSubUser } from '@/lib/geonode'
import { sendEmail, escapeHtml } from '@/lib/email'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: { user: caller } } = await supabase.auth.getUser(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: cp } = await supabase
    .from('profiles').select('role').eq('id', caller.id).single()
  if (cp?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const mfaCheck = await requireMfaVerified(req, caller.id)
  if (mfaCheck) return mfaCheck

  const { user_id } = await req.json()
  if (!user_id) return NextResponse.json({ error: 'Missing user_id' }, { status: 400 })

  const { data: tp } = await supabase
    .from('profiles')
    .select('role, email, full_name, is_deleted')
    .eq('id', user_id)
    .single()

  if (!tp) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (tp.role === 'admin') return NextResponse.json({ error: 'Cannot delete an admin account' }, { status: 403 })
  if (tp.is_deleted) return NextResponse.json({ error: 'User is already deleted' }, { status: 400 })

  // Step 1: Clean up live Geonode sub-users BEFORE touching any local rows.
  // profiles.id -> auth.users has ON DELETE CASCADE, and proxy_credentials,
  // bandwidth_accounts, orders, api_keys, proxy_sessions all cascade from
  // profiles in turn. Deleting the auth user first (as this route used to)
  // wipes proxy_credentials out of the DB with no record of which Geonode
  // sub-users existed — leaving real, billable sub-users orphaned on
  // Geonode's side with nothing locally to find or clean them up.
  const { data: creds } = await supabase
    .from('proxy_credentials')
    .select('id, geonode_sub_user_id, status')
    .eq('user_id', user_id)
    .not('geonode_sub_user_id', 'is', null)

  for (const cred of creds ?? []) {
    if (!cred.geonode_sub_user_id) continue
    await deleteSubUser(cred.geonode_sub_user_id).catch((e) =>
      console.error('Failed to clean up Geonode sub-user during account deletion', cred.id, e)
    )
  }

  // Step 2: Anonymise the profile.
  const { error: profileError } = await supabase
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
    .eq('id', user_id)

  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 500 })
  }

  // Step 3: Ban the auth account instead of deleting it. profiles.id
  // references auth.users ON DELETE CASCADE, so calling
  // auth.admin.deleteUser() here would cascade-delete the anonymised
  // profile row we just wrote (along with bandwidth_accounts, orders,
  // proxy_credentials, api_keys, proxy_sessions) and throw a raw FK
  // violation for any account with reseller_transfers history, blocking
  // deletion entirely. Banning permanently revokes login/API access while
  // leaving the anonymised tombstone and financial/audit records intact.
  //
  // This blocks future sign-ins/refreshes, not an already-issued access
  // token — Supabase has no API to revoke one before natural expiry, and
  // this route doesn't hold the target user's own JWT to revoke their
  // refresh token either. middleware.ts's is_deleted check (migration
  // 0029) is what actually closes that window on the very next request.
  const { error: banError } = await supabase.auth.admin.updateUserById(user_id, {
    ban_duration: '876000h', // ~100 years — effectively permanent
  })

  if (banError) {
    // Rollback anonymisation
    await supabase.from('profiles').update({
      full_name: tp.full_name,
      email: tp.email,
      is_deleted: false,
      deleted_at: null,
    }).eq('id', user_id)
    return NextResponse.json({ error: banError.message }, { status: 500 })
  }

  // Step 4: Mark any remaining credentials suspended so they read as
  // inactive everywhere they're surfaced (no 'deleted' value exists in the
  // status check constraint).
  if ((creds ?? []).length) {
    await supabase.from('proxy_credentials')
      .update({ status: 'suspended' })
      .eq('user_id', user_id)
  }

  // Step 5: Email — best-effort, non-fatal
  if (tp.email && tp.email !== '[deleted]') {
    await sendEmail({
      to: tp.email,
      subject: 'Your GlobProxy account has been deleted',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
          <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
            style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
          <h2 style="text-align:center;color:#111;">Account deleted</h2>
          <p style="color:#444;text-align:center;">
            Hi ${escapeHtml(tp.full_name) || 'there'}, your GlobProxy account has been permanently deleted.
            Your personal data has been removed. If you believe this was a mistake,
            please contact us as soon as possible.
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

  return NextResponse.json({ success: true })
}
