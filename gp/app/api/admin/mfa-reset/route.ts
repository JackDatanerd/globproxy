import { adminResetMfa } from '@/lib/mfa'
import { revokeAllSessions } from '@/lib/adminAccountSecurity'
import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { recordAndNotify } from '@/lib/securityEvents'
import { logAdminAction } from '@/lib/adminAudit'
import { NextResponse } from 'next/server'

// Self-service recovery deliberately dead-ends when someone has lost both
// their authenticator and every backup code (see lib/mfa.ts disableMfa
// doc comment) — that's what makes the codes a meaningful second factor
// rather than a formality. This is the intended way back in: an admin,
// after verifying the requester's identity out-of-band (support ticket,
// video call, whatever the team's process is), wipes the factor so the
// account drops back to "MFA not set up". MFA is optional platform-wide, so
// the user can sign in with just their password again; the dashboard's
// recommendation banner (and the email below) point them back to re-enabling
// it. Every reset is recorded in security_events with the acting admin.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ user_id?: unknown }>(req)
  if (!body) return badRequest('Invalid request body')
  const { user_id } = body
  if (!isUuid(user_id)) return badRequest('Missing or invalid user_id')

  // An admin's own session alone — no TOTP, no backup code — must never be
  // enough to strip their own MFA through this endpoint (a hijacked admin
  // session could otherwise swap in an attacker-controlled factor), and any
  // admin target is refused too, matching delete-user.
  if (user_id === adminId) {
    return NextResponse.json({ error: 'Use Settings to manage your own two-factor authentication.' }, { status: 403 })
  }

  const { data: target } = await supabase.from('profiles').select('email, full_name, role, is_deleted').eq('id', user_id).single()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'admin') return NextResponse.json({ error: 'Cannot reset MFA on an admin account this way — admins manage their own MFA from Settings.' }, { status: 403 })
  if (target.is_deleted) return NextResponse.json({ error: 'This account is deleted — there is nothing to reset.' }, { status: 409 })

  // adminResetMfa throws when the wipe fails; that used to escape as an
  // opaque 500 with no JSON body and no audit entry.
  try {
    await adminResetMfa(user_id)
  } catch (e: any) {
    console.error('[mfa-reset] wipe failed', user_id, e)
    await logAdminAction(supabase, { adminId, action: 'user.mfa_reset_failed', targetUserId: user_id, details: { error: String(e?.message ?? e) } })
    return NextResponse.json({ error: 'Could not reset two-factor authentication. Nothing was changed — try again.' }, { status: 500 })
  }
  // Whoever else is signed in to that account (the reason for a reset may be a
  // takeover) must sign in again.
  // Checked, not swallowed: a failed revoke is reported to the admin and recorded.
  const sessions = await revokeAllSessions(supabase, user_id)
  // Durable: stored with notify = true and e-mailed to the owner now; if the provider is down the
  // 'security' cron sweep retries for 24 h (the old direct send was lost on a failed attempt).
  await recordAndNotify({ userId: user_id, actorId: adminId, event: 'mfa_reset_by_admin', req, admin: supabase })
  await logAdminAction(supabase, {
    adminId, action: 'user.mfa_reset', targetUserId: user_id,
    details: { sessions_revoked: sessions.ok ? sessions.revoked : 0, ...(sessions.ok ? {} : { sessions_revoke_failed: true }) },
  })

  return NextResponse.json({
    success: true,
    sessions_revoked: sessions.ok,
    ...(sessions.ok ? {} : { warning: 'Two-factor was reset, but the account\'s other login sessions could not be ended. Use "Sign out everywhere" on the user page.' }),
  })
}
