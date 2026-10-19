import { sendEmail, escapeHtml } from '@/lib/email'
import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml } from '@/lib/adminEmail'
import { anonymisedProfilePatch, rollbackProfilePatch, cleanupGeonodeSubUsers, purgeAccountSecrets } from '@/lib/accountDeletion'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ user_id?: string }>(req)
  if (!body) return badRequest('Invalid request body')
  const { user_id } = body
  if (!isUuid(user_id)) return badRequest('Missing or invalid user_id')

  // Full row, so a failed later step can restore exactly what was blanked.
  const { data: tp } = await supabase.from('profiles').select('*').eq('id', user_id).single()

  if (!tp) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (tp.role === 'admin') return NextResponse.json({ error: 'Cannot delete an admin account' }, { status: 403 })
  if (tp.is_deleted) return NextResponse.json({ error: 'User is already deleted' }, { status: 400 })

  // Step 1: Release live Geonode sub-users BEFORE touching any local rows.
  // profiles.id -> auth.users cascades into proxy_credentials, so once the
  // local rows are gone there is no record of which sub-users existed.
  // A failure here now ABORTS the deletion (nothing local has changed, so
  // the admin can simply retry) instead of being logged and ignored.
  const { data: creds } = await supabase
    .from('proxy_credentials')
    .select('id, geonode_sub_user_id, status')
    .eq('user_id', user_id)
    .not('geonode_sub_user_id', 'is', null)

  const failed = await cleanupGeonodeSubUsers(creds ?? [])
  if (failed.length) {
    return NextResponse.json(
      {
        error: `Could not release ${failed.length} Geonode sub-user${failed.length === 1 ? '' : 's'}. Nothing was deleted — try again in a moment.`,
        failed,
      },
      { status: 502 }
    )
  }

  // Step 2: Anonymise the profile (name, email, company, applications,
  // payout details, 2FA flag). Suspension state is kept.
  const { error: profileError } = await supabase.from('profiles').update(anonymisedProfilePatch()).eq('id', user_id)
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 })

  // Step 3: Ban the auth account instead of deleting it (deleting would
  // cascade-delete the anonymised tombstone and fail on reseller_transfers
  // history). Blocks future sign-ins/refreshes; middleware.ts's is_deleted
  // check closes the window for an already-issued access token.
  const { error: banError } = await supabase.auth.admin.updateUserById(user_id, { ban_duration: '876000h' })
  if (banError) {
    await supabase.from('profiles').update(rollbackProfilePatch(tp)).eq('id', user_id)
    return NextResponse.json({ error: banError.message }, { status: 500 })
  }

  // Step 4: Credentials read as inactive and lose their stored password and
  // Geonode ids; webhook URLs/secrets, 2FA seeds / backup codes / trusted
  // browsers and support-report emails are removed; API keys are revoked.
  // Same end state as the self-service route.
  await purgeAccountSecrets(supabase, user_id, (creds ?? []).length > 0)

  await logAdminAction(supabase, {
    adminId,
    action: 'user.delete',
    targetUserId: user_id,
    details: { email: tp.email, role: tp.role, geonode_sub_users_released: (creds ?? []).length },
  })

  // Step 5: Email — best-effort, non-fatal
  if (tp.email && tp.email !== '[deleted]') {
    await sendEmail({
      to: tp.email,
      subject: 'Your GlobProxy account has been deleted',
      html: adminNoticeHtml({
        heading: 'Account deleted',
        bodyHtml: `Hi ${escapeHtml(tp.full_name) || 'there'}, your GlobProxy account has been permanently deleted. Your personal data has been removed. If you believe this was a mistake, please contact us as soon as possible.`,
        cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
      }),
    }).catch((e) => console.error('[delete-user] notification email failed:', e))
  }

  return NextResponse.json({ success: true })
}
