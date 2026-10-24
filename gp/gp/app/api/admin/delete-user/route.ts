import { sendEmail, escapeHtml } from '@/lib/email'
import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml } from '@/lib/adminEmail'
import { anonymisedProfilePatch, rollbackProfilePatch, releaseGeonodeSubUsers, purgeAccountSecrets, listReleasableCredentials } from '@/lib/accountDeletion'
import { BAN_FOREVER } from '@/lib/adminSuspend'
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

  // Step 2: Close the sign-in account FIRST. Banning (rather than deleting —
  // that would cascade-delete the anonymised tombstone and fail on
  // reseller_transfers history) blocks future sign-ins/refreshes;
  // middleware.ts's is_deleted check closes the window for an already-issued
  // access token. It is done before anything irreversible: if the ban fails
  // nothing upstream has been touched, so the customer keeps working proxies.
  // (It used to run after the supplier sub-users were released, so a failed ban
  // restored the profile but left the customer with dead proxies.)
  const { error: banError } = await supabase.auth.admin.updateUserById(user_id, { ban_duration: BAN_FOREVER })
  if (banError) {
    await supabase.from('profiles').update(rollbackProfilePatch(tp)).eq('id', user_id)
    await logAdminAction(supabase, {
      adminId, action: 'user.delete_aborted', targetUserId: user_id,
      details: { stage: 'auth_ban', error: banError.message },
    })
    return NextResponse.json({ error: `Could not close the sign-in account (${banError.message}). Nothing was changed. Try again.` }, { status: 500 })
  }

  // Step 3: Release live Geonode sub-users. profiles.id -> auth.users cascades
  // into proxy_credentials, so once local rows are gone nothing would record
  // which sub-users existed. Each one released is tombstoned locally the
  // moment it is gone. If any fails, the claim AND the ban are rolled back
  // (an account that was already suspended stays banned) and the admin is told
  // exactly what happened: some proxies may already be dead.
  const undoClaim = async () => {
    await supabase.from('profiles').update(rollbackProfilePatch(tp)).eq('id', user_id)
    const { error: unbanError } = await supabase.auth.admin.updateUserById(user_id, { ban_duration: tp.is_suspended ? BAN_FOREVER : 'none' })
    if (unbanError) console.error('[delete-user] could not restore the sign-in ban state after an aborted deletion', user_id, unbanError)
    return !unbanError
  }

  let creds
  try { creds = await listReleasableCredentials(supabase, user_id) }
  catch (e: any) {
    await undoClaim()
    return NextResponse.json({ error: `Could not read the account's proxy sessions (${e?.message ?? e}). Nothing was changed.` }, { status: 503 })
  }

  const { released, failed } = await releaseGeonodeSubUsers(supabase, creds)
  if (failed.length) {
    const restored = await undoClaim()
    await logAdminAction(supabase, {
      adminId, action: 'user.delete_aborted', targetUserId: user_id,
      details: { stage: 'release', released: released.length, failed: failed.length, ...(restored ? {} : { sign_in_ban_not_restored: true }) },
    })
    const partial = released.length
      ? ` ${released.length} of ${creds.length} proxy sessions were already released and are now shut down — the account itself was left intact.`
      : ' Nothing was changed.'
    return NextResponse.json(
      { error: `Could not release ${failed.length} proxy session${failed.length === 1 ? '' : 's'} upstream.${partial} Try again in a moment.${restored ? '' : ' The sign-in block could not be lifted again — unsuspend the account from its user page.'}`, failed, released: released.length },
      { status: 502 }
    )
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
      role: tp.role, geonode_sub_users_released: released.length,
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
