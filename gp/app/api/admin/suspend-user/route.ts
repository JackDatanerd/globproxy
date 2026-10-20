import { sendEmail, escapeHtml } from '@/lib/email'
import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { disableUserCredentials, enableUserCredentials, type ProxyToggleResult } from '@/lib/adminProxy'
import { NextResponse } from 'next/server'

const BAN_FOREVER = '876000h' // ~100 years — effectively permanent, reversible below

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ user_id?: string; action?: string; reason?: string }>(req)
  if (!body) return badRequest('Invalid request body')
  const { user_id, action } = body
  if (!isUuid(user_id)) return badRequest('Missing or invalid user_id')
  // Previously any value other than the literal 'suspend' (a typo, a
  // missing field on a future caller) silently fell through to UNSUSPEND.
  if (action !== 'suspend' && action !== 'unsuspend') return badRequest("action must be 'suspend' or 'unsuspend'")
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : ''

  const { data: tp } = await supabase
    .from('profiles')
    .select('role, email, full_name, is_suspended, is_deleted')
    .eq('id', user_id)
    .single()
  if (!tp) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (tp.role === 'admin') return NextResponse.json({ error: 'Cannot suspend admin' }, { status: 403 })
  // A deleted account's permanent ban is part of what "deleted" means.
  // Unsuspending one used to lift that ban (ban_duration: 'none').
  if (tp.is_deleted) return NextResponse.json({ error: 'This account has been deleted' }, { status: 409 })

  const isSuspending = action === 'suspend'
  if (isSuspending === !!tp.is_suspended) {
    return NextResponse.json(
      { error: isSuspending ? 'This account is already suspended' : 'This account is not suspended' },
      { status: 409 }
    )
  }

  let proxy: ProxyToggleResult = { changed: 0, failed: [] }

  if (isSuspending) {
    const { error } = await supabase.from('profiles').update({
      is_suspended: true,
      suspended_at: new Date().toISOString(),
      suspension_reason: reason || 'Suspended by admin',
    }).eq('id', user_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Block new logins / token refreshes. supabase-js resolves with
    // { error } rather than throwing, so the old `.catch(() => {})` never
    // saw a failure — the account was reported suspended with the ban
    // silently not applied. Now it's checked, and the profile flag is
    // rolled back so state never claims something that isn't true.
    const { error: banError } = await supabase.auth.admin.updateUserById(user_id, { ban_duration: BAN_FOREVER })
    if (banError) {
      await supabase.from('profiles').update({ is_suspended: false, suspended_at: null, suspension_reason: null }).eq('id', user_id)
      return NextResponse.json({ error: `Could not ban the auth account: ${banError.message}` }, { status: 500 })
    }

    // Stop live proxy traffic too — blocking the dashboard alone left
    // every Geonode sub-user working. Partial failures are reported, not
    // fatal: the account itself is suspended either way.
    proxy = await disableUserCredentials(supabase, user_id)
  } else {
    // Lift the ban FIRST: if it fails the profile is untouched and still
    // truthfully "suspended". The old order (profile first, ban second,
    // error ignored) could leave an account marked active but still banned.
    const { error: unbanError } = await supabase.auth.admin.updateUserById(user_id, { ban_duration: 'none' })
    if (unbanError) return NextResponse.json({ error: `Could not lift the ban: ${unbanError.message}` }, { status: 500 })

    const { error } = await supabase.from('profiles').update({
      is_suspended: false,
      suspended_at: null,
      suspension_reason: null,
    }).eq('id', user_id)
    if (error) {
      await supabase.auth.admin.updateUserById(user_id, { ban_duration: BAN_FOREVER })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    proxy = await enableUserCredentials(supabase, user_id)
  }

  await logAdminAction(supabase, {
    adminId,
    action: isSuspending ? 'user.suspend' : 'user.unsuspend',
    targetUserId: user_id,
    details: { reason: isSuspending ? (reason || 'Suspended by admin') : undefined, credentials_changed: proxy.changed, credential_failures: proxy.failed.length, credentials_kept_disabled: proxy.kept_disabled ?? 0 },
  })

  if (tp.email && tp.email !== '[deleted]') {
    const name = escapeHtml(tp.full_name) || 'there'
    await sendEmail({
      to: tp.email,
      subject: isSuspending ? 'Your GlobProxy account has been suspended' : 'Your GlobProxy account has been reinstated',
      html: isSuspending
        ? adminNoticeHtml({
            heading: 'Account suspended',
            bodyHtml: `Hi ${name}, your GlobProxy account has been suspended.${reason ? ` Reason: ${escapeHtml(reason)}.` : ''} If you believe this is a mistake, please contact us.`,
            cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
          })
        : adminNoticeHtml({
            heading: 'Account reinstated ✓',
            bodyHtml: `Hi ${name}, your GlobProxy account has been reinstated. You can now log back in and continue using our services.`,
            cta: { href: `${appUrl()}/auth/login`, label: 'Sign in →' },
          }),
    }).catch((e) => console.error('[suspend-user] notification email failed:', e))
  }

  return NextResponse.json({
    success: true,
    proxies_changed: proxy.changed,
    proxy_failures: proxy.failed,
    // Credentials an admin disabled one by one stay off after a reinstate.
    credentials_kept_disabled: proxy.kept_disabled ?? 0,
  })
}
