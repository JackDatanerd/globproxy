import { sendEmail, escapeHtml } from '@/lib/email'
import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { NextResponse } from 'next/server'

type Action = 'make_reseller' | 'make_user' | 'grant_api_access' | 'revoke_api_access' | 'toggle_api_access'

// Handles the role-change and API-access actions from AdminUserControls.tsx.
//
// API access is now set EXPLICITLY (grant_api_access / revoke_api_access).
// 'toggle_api_access' is still accepted for older clients but is resolved
// against the value read here, so a double-click or two open tabs can no
// longer flip it straight back — the explicit actions are idempotent.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ user_id?: string; action?: Action }>(req)
  if (!body) return badRequest('Invalid request body')
  const { user_id, action } = body
  if (!isUuid(user_id) || !action) return badRequest('Missing fields')

  const { data: target } = await supabase
    .from('profiles')
    .select('role, api_access, email, full_name, is_deleted')
    .eq('id', user_id)
    .single()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'admin') return NextResponse.json({ error: 'Cannot modify an admin account' }, { status: 403 })
  // Emailing '[deleted]' and re-privileging a tombstone helps nobody.
  if (target.is_deleted) return NextResponse.json({ error: 'This account has been deleted' }, { status: 409 })

  let resolved: Exclude<Action, 'toggle_api_access'>
  if (action === 'toggle_api_access') resolved = target.api_access ? 'revoke_api_access' : 'grant_api_access'
  else resolved = action

  let updates: Record<string, any>
  switch (resolved) {
    case 'make_reseller':
      if (target.role === 'reseller') return NextResponse.json({ error: 'Already a reseller' }, { status: 409 })
      updates = { role: 'reseller', reseller_status: 'approved' }
      break
    case 'make_user':
      if (target.role === 'user') return NextResponse.json({ error: 'Already a regular user' }, { status: 409 })
      // Clear reseller_status AND API access: API access only applies to
      // resellers (lib/apiAuth.ts rejects role 'user' regardless), so a
      // demoted account shouldn't keep a stale api_access = true.
      updates = { role: 'user', reseller_status: null, api_access: false, api_access_status: null }
      break
    case 'grant_api_access':
      // approve-api-access only ever allows resellers; this shortcut now
      // matches instead of quietly granting API access to plain users.
      if (target.role !== 'reseller') return NextResponse.json({ error: 'API access only applies to reseller accounts.' }, { status: 400 })
      if (target.api_access) return NextResponse.json({ error: 'API access is already enabled' }, { status: 409 })
      updates = { api_access: true, api_access_status: 'approved' }
      break
    case 'revoke_api_access':
      if (!target.api_access) return NextResponse.json({ error: 'API access is already disabled' }, { status: 409 })
      updates = { api_access: false, api_access_status: null }
      break
    default:
      return badRequest('Unknown action')
  }

  const { error } = await supabase.from('profiles').update(updates).eq('id', user_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction(supabase, {
    adminId,
    action: `user.${resolved}`,
    targetUserId: user_id,
    details: { from_role: target.role, updates },
  })

  // Best-effort notification — the access change already succeeded.
  if (target.email) {
    const firstName = escapeHtml(target.full_name?.split(' ')[0]) || 'there'
    let subject = ''
    let heading = ''
    let text = ''
    let cta = { href: 'mailto:support@globproxy.com', label: 'Contact support →' }

    if (resolved === 'make_reseller') {
      subject = "You're now a GlobProxy reseller"
      heading = "You're now a reseller ✓"
      text = `Hi ${firstName}, your account has been switched to a reseller account. You can now buy wholesale bandwidth and allocate it to your own clients under your own brand.`
      cta = { href: `${appUrl()}/reseller`, label: 'Go to reseller dashboard →' }
    } else if (resolved === 'make_user') {
      subject = 'Your GlobProxy reseller status has been removed'
      heading = 'Reseller status removed'
      text = `Hi ${firstName}, your account is no longer a reseller account — it's back to a regular customer account. Any bandwidth you'd already allocated to clients is unaffected. If this wasn't expected, contact support.`
    } else if (resolved === 'grant_api_access') {
      subject = 'API access has been enabled on your GlobProxy account'
      heading = 'API access enabled ✓'
      text = `Hi ${firstName}, API access has been enabled on your account. Generate a key from API Keys in your dashboard to get started.`
      cta = { href: `${appUrl()}/dashboard/api-keys`, label: 'Go to API Keys →' }
    } else {
      subject = 'API access has been disabled on your GlobProxy account'
      heading = 'API access disabled'
      text = `Hi ${firstName}, API access has been disabled on your account. Any existing keys stop working immediately. If this wasn't expected, contact support.`
    }

    await sendEmail({ to: target.email, subject, html: adminNoticeHtml({ heading, bodyHtml: text, cta }) })
      .catch((e) => console.error('[update-user] notification email failed:', e))
  }

  // No session-kill needed on a downgrade: every authorization check in
  // this app (RLS, requireApiAccess, every admin route) reads role /
  // api_access / is_suspended fresh from `profiles` per request, so a
  // downgraded user's still-live session is already fully constrained the
  // moment the update above commits.
  return NextResponse.json({ success: true, updates })
}
