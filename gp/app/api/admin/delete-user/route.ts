import { sendEmail, escapeHtml } from '@/lib/email'
import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml } from '@/lib/adminEmail'
import { anonymisedProfilePatch, rollbackProfilePatch, releaseGeonodeSubUsers, purgeAccountSecrets } from '@/lib/accountDeletion'
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
  if (tp.is_deleted) return NextResponse.json({ error: 'User is already deleted' }, { status: 409 })

  // Step 1: CLAIM the deletion. The anonymise update is conditional on
  // is_deleted = false, so two admins (or a double click) can't both run the
  // irreversible steps below: the loser gets a 409 here. The pre-deletion row
  // captured above is what any rollback restores.
  const { data: claimed, error: claimError } = await supabase
    .from('profiles')
    .update(anonymisedProfilePatch())
    .eq('id', user_id)
    .or('is_deleted.is.null,is_deleted.eq.false') // nullable column
    .select('id')
  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 })
  if (!claimed?.length) return NextResponse.json({ error: 'User is already deleted' }, { status: 409 })

  // Step 2: Release live Geonode sub-users. profiles.id -> auth.users cascades
  // into proxy_credentials, so once local rows are gone nothing would record
  // which sub-users existed. Each one released is tombstoned locally the
  // moment it is gone. If any fails, the claim is rolled back and the admin is
  // told exactly what happened: some proxies may already be dead.
  const { data: creds } = await supabase
    .from('proxy_credentials')
    .select('id, upstream_sub_user_id, status')
    .eq('user_id', user_id)
    .not('upstream_sub_user_id', 'is', null)

  const { released, failed } = await releaseGeonodeSubUsers(supabase, creds ?? [])
  if (failed.length) {
    await supabase.from('profiles').update(rollbackProfilePatch(tp)).eq('id', user_id)
    await logAdminAction(supabase, {
      adminId, action: 'user.delete_aborted', targetUserId: user_id,
      details: { released: released.length, failed: failed.length },
    })
    const partial = released.length
      ? ` ${released.length} of ${(creds ?? []).length} proxy sessions were already released and are now shut down — the account itself was left intact.`
      : ' Nothing was changed.'
    return NextResponse.json(
      { error: `Could not release ${failed.length} proxy session${failed.length === 1 ? '' : 's'} upstream.${partial} Try again in a moment.`, failed, released: released.length },
      { status: 502 }
    )
  }

  // Step 3: Ban the auth account instead of deleting it (deleting would
  // cascade-delete the anonymised tombstone and fail on reseller_transfers
  // history). Blocks future sign-ins/refreshes; middleware.ts's is_deleted
  // check closes the window for an already-issued access token.
  const { error: banError } = await supabase.auth.admin.updateUserById(user_id, { ban_duration: '876000h' })
  if (banError) {
    await supabase.from('profiles').update(rollbackProfilePatch(tp)).eq('id', user_id)
    // The proxy sessions were already released at this point, so the admin needs
    // this on record (and in the message), not a bare 500.
    await logAdminAction(supabase, {
      adminId, action: 'user.delete_aborted', targetUserId: user_id,
      details: { stage: 'auth_ban', released: released.length, error: banError.message },
    })
    return NextResponse.json({
      error: `Could not close the sign-in account (${banError.message}). The profile was restored${released.length ? `, but ${released.length} proxy session${released.length === 1 ? ' was' : 's were'} already shut down` : ''}. Try again.`,
    }, { status: 500 })
  }

  // Step 4: Credentials read as inactive and lose their stored password and
  // Geonode ids; webhook URLs/secrets, 2FA seeds / backup codes / trusted
  // browsers and support-report emails are removed; API keys are revoked;
  // pending payouts are voided. Same end state as the self-service route.
  const purge = await purgeAccountSecrets(supabase, user_id)

  await logAdminAction(supabase, {
    adminId,
    action: 'user.delete',
    targetUserId: user_id,
    details: {
      email: tp.email, role: tp.role, geonode_sub_users_released: released.length,
      payouts_voided: purge.scrub?.voided_payouts ?? [],
      earnings_forfeited_usd: purge.scrub?.forfeited_usd ?? 0,
      ...(purge.warnings.length ? { cleanup_warnings: purge.warnings } : {}),
    },
  })

  // Step 5: Email — best-effort, non-fatal
  if (tp.email && tp.email !== '[deleted]') {
    await sendEmail({
      to: tp.email,
      subject: 'Your GlobProxy account has been deleted',
      html: adminNoticeHtml({
        heading: 'Account deleted',
        bodyHtml: `Hi ${escapeHtml(tp.full_name) || 'there'}, your GlobProxy account has been closed. Your profile, payout details, proxy credentials and stored secrets have been removed. We keep only the records we are required to retain (such as invoices and payment history), and the email address stays blocked so the account cannot be reopened. If you believe this was a mistake, please contact us as soon as possible.`,
        cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
      }),
    }).catch((e) => console.error('[delete-user] notification email failed:', e))
  }

  return NextResponse.json({
    success: true,
    payouts_voided: purge.scrub?.voided_payouts?.length ?? 0,
    ...(purge.warnings.length ? { warnings: purge.warnings } : {}),
  })
}
