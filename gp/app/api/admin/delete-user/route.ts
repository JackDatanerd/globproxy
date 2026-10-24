import { sendEmail, escapeHtml } from '@/lib/email'
import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml } from '@/lib/adminEmail'
import { performAccountDeletion } from '@/lib/accountDeletion'
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

  // Claim → ban → release every supplier sub-user → purge: ONE implementation shared
  // with the customer's own deletion and the scheduled run (lib/accountDeletion.ts).
  //  * The claim is conditional on is_deleted = false, so two admins (or a click racing
  //    the customer's scheduled deletion) can't both run the irreversible steps.
  //  * The sign-in account is banned BEFORE anything irreversible: if that fails nothing
  //    upstream was touched, so the customer keeps working proxies.
  //  * If any sub-user cannot be released, the claim AND the ban are rolled back (an
  //    account that was already suspended stays banned) and the admin is told exactly
  //    what happened: some proxies may already be dead — those are settled, not orphaned.
  const result = await performAccountDeletion(supabase, user_id, { before: tp })
  if (!result.ok) {
    if (result.stage === 'already_deleted') return NextResponse.json({ error: 'User is already deleted' }, { status: 409 })
    if (result.stage === 'claim') return NextResponse.json({ error: result.error }, { status: 500 })
    if (result.stage === 'ban') {
      await logAdminAction(supabase, {
        adminId, action: 'user.delete_aborted', targetUserId: user_id,
        details: { stage: 'auth_ban', error: result.error },
      })
      return NextResponse.json({ error: `Could not close the sign-in account (${result.error}). Nothing was changed. Try again.` }, { status: 500 })
    }
    if (result.stage === 'list') {
      return NextResponse.json({ error: `Could not read the account's proxy sessions (${result.error}). Nothing was changed.${result.signInBanNotRestored ? ' The sign-in block could not be lifted again — unsuspend the account from its user page.' : ''}` }, { status: 503 })
    }
    const restored = !result.signInBanNotRestored
    const released = result.released ?? 0
    const failed = result.failed ?? []
    await logAdminAction(supabase, {
      adminId, action: 'user.delete_aborted', targetUserId: user_id,
      details: { stage: 'release', released, failed: failed.length, ...(restored ? {} : { sign_in_ban_not_restored: true }) },
    })
    const partial = released
      ? ` ${released} of ${result.total ?? released + failed.length} proxy sessions were already released and are now shut down — the account itself was left intact.`
      : ' Nothing was changed.'
    return NextResponse.json(
      { error: `Could not release ${failed.length} proxy session${failed.length === 1 ? '' : 's'} upstream.${partial} Try again in a moment.${restored ? '' : ' The sign-in block could not be lifted again — unsuspend the account from its user page.'}`, failed, released },
      { status: 502 }
    )
  }
  const purge = result.purge
  const released = { length: result.released }

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
