import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { logSecurityEvent } from '@/lib/securityEvents'
import { revokeAllSessions, revokeAllApiKeys } from '@/lib/adminAccountSecurity'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { sendEmailSafe, escapeHtml } from '@/lib/email'

// POST { user_id, revokeApiKeys?, notify? } — incident response for an account
// that may be taken over: ends every login session and (optionally) revokes
// every API key, then (optionally) tells the owner to reset their password.
//
// Nothing here changes the password or 2FA, so the owner can sign straight back
// in; it removes whoever else is holding a session or a key. Pair it with a
// suspension when the owner themselves is the problem.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ user_id?: unknown; revokeApiKeys?: unknown; notify?: unknown }>(req)
  if (!body) return badRequest('Invalid request body')
  if (!isUuid(body.user_id)) return badRequest('Missing or invalid user_id')
  const userId = body.user_id
  const revokeKeys = body.revokeApiKeys === true
  const notify = body.notify !== false

  if (userId === adminId) return NextResponse.json({ error: 'Use Settings → Active sessions to sign yourself out.' }, { status: 403 })

  const { data: target } = await supabase.from('profiles').select('email, full_name, role, is_deleted').eq('id', userId).single()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'admin') return NextResponse.json({ error: 'Cannot sign out another admin from here.' }, { status: 403 })
  if (target.is_deleted) return NextResponse.json({ error: 'This account is deleted.' }, { status: 409 })

  const sessions = await revokeAllSessions(supabase, userId)
  const keys = revokeKeys ? await revokeAllApiKeys(supabase, userId) : null

  await logSecurityEvent({ userId, actorId: adminId, event: 'signout_others', req, admin: supabase })
    .catch(e => console.error('[force-signout] security event failed', e))
  await logAdminAction(supabase, {
    adminId, action: 'user.force_signout', targetUserId: userId,
    details: {
      sessions_revoked: sessions.ok ? sessions.revoked : 0,
      ...(sessions.ok ? {} : { sessions_revoke_failed: true }),
      ...(keys ? { api_keys_revoked: keys.revoked, ...(keys.ok ? {} : { api_keys_revoke_failed: true }) } : {}),
    },
  })

  if (notify && target.email && target.email !== '[deleted]' && sessions.ok) {
    await sendEmailSafe({
      to: target.email,
      subject: 'You were signed out of your GlobProxy account',
      html: adminNoticeHtml({
        heading: 'Signed out of all devices',
        bodyHtml: `Hi ${escapeHtml(target.full_name) || 'there'}, our support team signed your GlobProxy account out of every device${keys?.ok && keys.revoked ? ` and revoked ${keys.revoked} API key${keys.revoked === 1 ? '' : 's'}` : ''} as a security precaution. You can sign back in now. If you did not expect this, change your password straight away and re-check your two-factor settings.`,
        cta: { href: `${appUrl()}/auth/reset`, label: 'Change my password →' },
      }),
    })
  }

  const failed = !sessions.ok || (keys && !keys.ok)
  if (failed) {
    return NextResponse.json({
      error: `${!sessions.ok ? 'Sessions could not be ended' : 'API keys could not be revoked'} — try again.`,
      sessions_revoked: sessions.ok ? sessions.revoked : 0,
      api_keys_revoked: keys?.revoked ?? 0,
    }, { status: 502 })
  }
  return NextResponse.json({ success: true, sessions_revoked: sessions.revoked, api_keys_revoked: keys?.revoked ?? 0 })
}
