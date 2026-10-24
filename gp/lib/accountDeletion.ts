import { deleteSubUser, listAllSubUsers, getSubUserUsage, GeonodeApiError } from '@/lib/geonode'
import type { AdminSupabase } from '@/lib/adminAuth'
import { anonymisedProfilePatch, rollbackProfilePatch } from '@/lib/accountPatch'
import { BAN_FOREVER } from '@/lib/adminSuspend'
import { sendEmailSafe } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'

// Used by app/api/admin/delete-user. It deliberately leaves an account in
// exactly the same end state as the self-service route
// (app/api/user/delete-account/route.ts): same fields wiped, same secrets
// purged, suspension state preserved. If you change one, change the other.

export { anonymisedProfilePatch, rollbackProfilePatch } from '@/lib/accountPatch'

// Every column that points at, or holds the login for, a live upstream sub-user.
// A tombstoned credential carries none of them. provision_username / provision_password
// (migration 0064) are the identity a PENDING credential reserved BEFORE the supplier
// was called; they were missing from the old tombstone, so a pending credential kept a
// plaintext password after deletion — and, when the attempt had died ambiguously after
// the sub-user was created, the sub-user itself was never released.
const TOMBSTONE_SECRETS = {
  upstream_password: null, upstream_username: null,
  provision_password: null,
  pending_reason: null, last_provision_error: null,
} as const

export type ReleasableCredential = { id: string; upstream_sub_user_id: string | null; provision_username?: string | null }

// Credentials that may own a live sub-user: a recorded sub-user id, OR a reserved
// provisioning identity (the sub-user may exist even though its id was never saved).
export async function listReleasableCredentials(supabase: AdminSupabase, userId: string): Promise<ReleasableCredential[]> {
  const { data, error } = await supabase
    .from('proxy_credentials')
    .select('id, upstream_sub_user_id, provision_username')
    .eq('user_id', userId)
    .or('upstream_sub_user_id.not.is.null,provision_username.not.is.null')
  if (error) throw new Error(`could not list credentials to release: ${error.message}`)
  return (data ?? []) as ReleasableCredential[]
}

// Releases every listed upstream sub-user. A 404 means it is already gone (a
// retry after a partial run) and counts as released. Each released credential
// is tombstoned locally AT ONCE (stored password and upstream ids dropped,
// status 'suspended', reason 'deleted'), so if a later sub-user fails and the
// deletion is abandoned, the database never claims a dead sub-user is still
// live. Callers must stop before the account is finalised if anything failed —
// swallowing the error leaves a real, billable, still-working sub-user behind
// an account that reads as deleted.
//
// A credential with no sub-user id but a reserved provisioning identity is looked
// up by that exact username in the supplier's listing (read once, lazily). Not found
// in a COMPLETE listing means there is nothing to release; not found in an incomplete
// one proves nothing, so it counts as failed.
export async function releaseUpstreamSubUsers(
  supabase: AdminSupabase,
  creds: ReleasableCredential[]
): Promise<{ released: string[]; failed: { id: string; error: string }[] }> {
  const released: string[] = []
  const failed: { id: string; error: string }[] = []
  let listing: Awaited<ReturnType<typeof listAllSubUsers>> | null = null
  for (const cred of creds) {
    let subUserId = cred.upstream_sub_user_id
    // Live usage BEFORE the sub-user is deleted (it may not be queryable afterwards),
    // exactly as deleteCredential() does for a single session: the larger of it and
    // the last synced figure is what counts as consumed when the accounting is settled.
    let liveUsedGb: number | null = null
    if (subUserId) {
      try { liveUsedGb = await getSubUserUsage(subUserId) }
      catch (e) { console.error('[accountDeletion] live usage read failed, settling on the synced figure', cred.id, e) }
    }
    try {
      if (!subUserId && cred.provision_username) {
        listing ??= await listAllSubUsers()
        for (const [id, snap] of listing.subUsers) if (snap.username === cred.provision_username) { subUserId = id; break }
        if (!subUserId && !listing.complete) throw new Error('supplier sub-user listing incomplete — cannot confirm the reserved sub-user does not exist')
      }
      if (subUserId) await deleteSubUser(subUserId)
    } catch (e: any) {
      if (!(e instanceof GeonodeApiError && e.status === 404)) {
        console.error('Failed to clean up upstream sub-user during account deletion', cred.id, e)
        failed.push({ id: cred.id, error: String(e?.message ?? e) })
        continue
      }
    }
    if (!subUserId && !cred.upstream_sub_user_id && !cred.provision_username) continue
    released.push(cred.id)
    const { error } = await supabase.from('proxy_credentials')
      .update({
        status: 'suspended', suspended_reason: 'deleted',
        ...TOMBSTONE_SECRETS,
        upstream_sub_user_id: null, provision_username: null,
      })
      .eq('id', cred.id)
    if (error) { console.error('[accountDeletion] could not tombstone released credential', cred.id, error); continue }
    // Settle the bandwidth accounting the way deleting a session does: unused GB goes
    // back to the balance and consumed GB moves to the archive. Tombstoning alone left
    // the account's allocated_gb inflated (and the dead session's usage double counted
    // in used_gb) — including on an admin-aborted deletion where the account lives on.
    // A failure here is retried by the 'deletions' sweep (settled_at stays null).
    const settle = await supabase.rpc('settle_released_credential', { p_credential_id: cred.id, p_live_used_gb: liveUsedGb })
    if (settle.error) console.error('[accountDeletion] could not settle released credential', cred.id, settle.error.message)
  }
  return { released, failed }
}

export type PurgeResult = {
  // Steps that errored — the account is deleted either way, but something
  // sensitive may still be on disk and an admin should look.
  warnings: string[]
  // What the affiliate scrub did (pending payouts removed, earnings forfeited).
  scrub: { voided_payouts?: any[]; forfeited_usd?: number } | null
}

// Everything after the profile is anonymised and the auth account banned:
// credentials read as inactive and lose their stored password / upstream ids
// (ALL of the account's credentials, not only ones that had a sub-user id),
// secrets with no accounting value are deleted, API keys are revoked.
// Orders, invoices and ledgers are kept for accounting. Every step is checked
// and reported instead of silently ignored.
export async function purgeAccountSecrets(supabase: AdminSupabase, userId: string, _hadCredentials?: boolean): Promise<PurgeResult> {
  const warnings: string[] = []
  const check = (step: string, error: { message: string } | null) => {
    if (error) { warnings.push(`${step}: ${error.message}`); console.error('[accountDeletion]', step, userId, error) }
  }

  // Second pass over the supplier side. The route released what it could see BEFORE
  // the account was finalised; a credential activated by the provisioning cron in the
  // meantime (or a reserved identity) would otherwise be tombstoned below with its
  // sub-user id nulled — a live, billable sub-user nothing points at. Release again
  // now; anything that still cannot be released keeps its id/username so it stays
  // findable, and is reported in `warnings`.
  let stillLive: string[] = []
  try {
    const remaining = await listReleasableCredentials(supabase, userId)
    const { failed } = await releaseUpstreamSubUsers(supabase, remaining)
    stillLive = failed.map((f) => f.id)
    for (const f of failed) warnings.push(`upstream_release ${f.id}: ${f.error}`)
  } catch (e: any) {
    check('upstream_release', { message: String(e?.message ?? e) })
  }
  // Everything else: inactive, secrets gone. The ids are kept only for credentials
  // whose sub-user could not be confirmed gone.
  {
    const q = supabase.from('proxy_credentials')
      .update({ status: 'suspended', suspended_reason: 'deleted', ...TOMBSTONE_SECRETS })
      .eq('user_id', userId)
    check('credentials', (await q).error)
    let ids = supabase.from('proxy_credentials')
      .update({ upstream_sub_user_id: null, provision_username: null })
      .eq('user_id', userId)
    if (stillLive.length) ids = ids.not('id', 'in', `(${stillLive.join(',')})`)
    check('credential_ids', (await ids).error)
  }
  // auth.users keeps its own copy of what the person typed at signup (name,
  // intended role, ...) in user_metadata; the profile scrub never touches it.
  // GoTrue merges metadata and removes a key set to null, so null every key.
  // The sign-in email itself stays on the banned record on purpose (it blocks
  // re-registration — the deletion email says so).
  try {
    const { data: au, error: getErr } = await supabase.auth.admin.getUserById(userId)
    if (getErr) throw getErr
    const meta = (au?.user?.user_metadata ?? {}) as Record<string, unknown>
    const keys = Object.keys(meta)
    if (keys.length) {
      const wipe: Record<string, null> = {}
      for (const k of keys) wipe[k] = null
      check('auth_user_metadata', (await supabase.auth.admin.updateUserById(userId, { user_metadata: wipe })).error)
    }
  } catch (e: any) {
    check('auth_user_metadata', { message: String(e?.message ?? e) })
  }
  check('webhook_endpoints', (await supabase.from('webhook_endpoints').delete().eq('user_id', userId)).error)
  // The API request log holds source IPs; the profile row is kept (scrubbed), so
  // the FK cascade never fires — clear it explicitly (migration 0054).
  check('api_request_log', (await supabase.from('api_request_log').delete().eq('user_id', userId)).error)
  // Real IP / user-agent per sign-in, the audit trail (its meta and IP columns)
  // and any quarantined signup password: nothing here has accounting value once
  // the account is closed, and the profile row survives, so the FK cascades
  // never fire (migration 0060).
  check('login_sessions', (await supabase.from('login_sessions').delete().eq('user_id', userId)).error)
  // Everything but the 'account_deleted' tombstone goes; the tombstone itself
  // is stripped of IP / user-agent / metadata.
  check('security_events', (await supabase.from('security_events').delete().eq('user_id', userId).neq('event', 'account_deleted')).error)
  check('security_events_scrub', (await supabase.from('security_events')
    .update({ ip: null, user_agent: null, meta: {} }).eq('user_id', userId).eq('event', 'account_deleted')).error)
  check('mfa_recovery_requests', (await supabase.from('mfa_recovery_requests').delete().eq('user_id', userId)).error)
  check('auth_pending_password', (await supabase.from('auth_pending_password').delete().eq('user_id', userId)).error)
  check('mfa_totp_factors', (await supabase.from('mfa_totp_factors').delete().eq('user_id', userId)).error)
  check('mfa_backup_codes', (await supabase.from('mfa_backup_codes').delete().eq('user_id', userId)).error)
  check('mfa_verified_sessions', (await supabase.from('mfa_verified_sessions').delete().eq('user_id', userId)).error)
  // The free text of a report can hold anything the person typed (names, phone numbers,
  // account details) and the page it was sent from. Nothing here has accounting value,
  // so it goes with the account; open reports from a closed account are closed.
  check('support_reports', (await supabase.from('support_reports')
    .update({ email: '[deleted]', message: '[removed — account deleted]', page_url: null })
    .eq('user_id', userId)).error)
  check('support_reports_close', (await supabase.from('support_reports')
    .update({ status: 'resolved', resolved_at: new Date().toISOString(), admin_note: 'Account deleted' })
    .eq('user_id', userId).eq('status', 'open')).error)
  // What support wrote back to the customer is theirs too — goes with the account.
  {
    const { data: reportRows, error: reportErr } = await supabase.from('support_reports').select('id').eq('user_id', userId)
    check('support_report_ids', reportErr)
    const ids = (reportRows ?? []).map((r: any) => r.id)
    if (ids.length) check('support_report_replies', (await supabase.from('support_report_replies').delete().in('report_id', ids)).error)
  }
  check('api_keys', (await supabase.from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null)).error)

  // Affiliate side (migrations 0044 / 0051 / 0052): suspend the affiliate status so
  // nothing new accrues to a deleted account, void its still-pending payouts
  // (their destination was just erased) and forfeit UNBATCHED earnings. Paid
  // payout rows are kept — they're financial records. Idempotent.
  const { data: scrub, error: scrubErr } = await supabase.rpc('scrub_affiliate_data', { p_user_id: userId })
  check('scrub_affiliate_data', scrubErr)

  return { warnings, scrub: (scrub as any) ?? null }
}

// ── In-flight payments ───────────────────────────────────────────────
// A payment still being processed would be credited to the account AFTER it is closed
// (the webhook / reconcile cannot tell) and nobody would be refunded. Pending checkouts
// older than two hours are abandoned ones; a paid order that never got credited is
// always a reason to wait. Shared by the route and the scheduled run.
export async function countInFlightPayments(supabase: AdminSupabase, userId: string): Promise<{ count: number; error: string | null }> {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const { count, error } = await supabase
    .from('orders').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('bandwidth_credited', false)
    .or(`and(payment_status.eq.pending,created_at.gt.${twoHoursAgo}),payment_status.eq.paid`)
  return { count: count ?? 0, error: error?.message ?? null }
}

// ── The deletion itself ──────────────────────────────────────────────
// ONE implementation behind the customer's own deletion (immediate or after the
// cool-off) and the admin's. Order matters:
//   1. CLAIM — the anonymise update is conditional on is_deleted being false, so two
//      requests (a double click, a click racing the scheduled run) can never both run
//      the irreversible steps; the loser gets 'already_deleted'. (The self-service route
//      used to anonymise unconditionally after releasing the supplier sub-users, so two
//      concurrent calls both released, both purged and both e-mailed.)
//   2. BAN the sign-in account — if that fails nothing upstream has been touched.
//   3. RELEASE every supplier sub-user. Failure rolls the claim AND the ban back.
//   4. Revoke the caller's sessions, purge secrets, persist anything left over.
export type DeletionOutcome =
  | { ok: true; released: number; purge: PurgeResult; cleanupPending: boolean }
  | {
      ok: false
      stage: 'claim' | 'already_deleted' | 'ban' | 'list' | 'release'
      error: string
      released?: number
      total?: number
      failed?: { id: string; error: string }[]
      signInBanNotRestored?: boolean
    }

export async function performAccountDeletion(
  supabase: AdminSupabase,
  userId: string,
  opts: { before: Record<string, any>; accessToken?: string | null },
): Promise<DeletionOutcome> {
  const { before } = opts

  const { data: claimed, error: claimError } = await supabase
    .from('profiles')
    .update(anonymisedProfilePatch())
    .eq('id', userId)
    .or('is_deleted.is.null,is_deleted.eq.false') // nullable column
    .select('id')
  if (claimError) return { ok: false, stage: 'claim', error: claimError.message }
  if (!claimed?.length) return { ok: false, stage: 'already_deleted', error: 'Account already deleted.' }

  const { error: banError } = await supabase.auth.admin.updateUserById(userId, { ban_duration: BAN_FOREVER })
  if (banError) {
    await supabase.from('profiles').update(rollbackProfilePatch(before)).eq('id', userId)
    return { ok: false, stage: 'ban', error: banError.message }
  }

  const undoClaim = async () => {
    await supabase.from('profiles').update(rollbackProfilePatch(before)).eq('id', userId)
    const { error: unbanError } = await supabase.auth.admin.updateUserById(userId, { ban_duration: before.is_suspended ? BAN_FOREVER : 'none' })
    if (unbanError) console.error('[accountDeletion] could not restore the sign-in ban state after an aborted deletion', userId, unbanError)
    return !unbanError
  }

  let creds: ReleasableCredential[]
  try { creds = await listReleasableCredentials(supabase, userId) }
  catch (e: any) {
    const restored = await undoClaim()
    return { ok: false, stage: 'list', error: String(e?.message ?? e), signInBanNotRestored: !restored }
  }

  const { released, failed } = await releaseUpstreamSubUsers(supabase, creds)
  if (failed.length) {
    const restored = await undoClaim()
    return { ok: false, stage: 'release', error: `${failed.length} proxy session(s) could not be released`, released: released.length, total: creds.length, failed, signInBanNotRestored: !restored }
  }

  // End every session of the account (the admin signOut API is keyed on a JWT of the
  // account's owner, which only the self-service path holds). Best-effort: the ban blocks
  // refreshes and middleware blocks the pages anyway.
  if (opts.accessToken) {
    try {
      const { error: outErr } = await supabase.auth.admin.signOut(opts.accessToken, 'global')
      if (outErr) console.error('[accountDeletion] global sign-out failed', userId, outErr.message)
    } catch (e) { console.error('[accountDeletion] global sign-out threw', userId, e) }
  }

  const purge = await purgeAccountSecrets(supabase, userId)
  if (purge.warnings.length) console.error('[accountDeletion] cleanup warnings', userId, purge.warnings)

  // Leftovers are persisted, not just logged: the 'deletions' task retries them and
  // tells the admin if they do not clear. (A warning used to live in one log line
  // and in a response nobody was reading.)
  const cleanupPending = purge.warnings.length > 0
  const { error: markErr } = await supabase.from('profiles').update({
    deletion_cleanup_pending: cleanupPending,
    deletion_cleanup_notes: cleanupPending ? purge.warnings.join('\n').slice(0, 4000) : null,
    deletion_last_error: null,
    deletion_attempts: 0, // from here on it counts CLEANUP retries
  }).eq('id', userId)
  if (markErr) console.error('[accountDeletion] could not record cleanup state', userId, markErr.message)
  if (cleanupPending) await alertAdminCleanup(userId, purge.warnings)

  return { ok: true, released: released.length, purge, cleanupPending }
}

async function alertAdminCleanup(userId: string, warnings: string[]) {
  const to = process.env.ADMIN_EMAIL
  if (!to) return
  await sendEmailSafe({
    to,
    subject: '[ACCOUNT DELETION] finished with leftovers — will retry',
    html: `<p>An account (<code>${userId}</code>) was deleted, but ${warnings.length} cleanup step(s) failed.
           The hourly <strong>deletions</strong> task retries them and will e-mail again if they do not clear.</p>
           <pre style="white-space:pre-wrap">${warnings.map((w) => w.replace(/</g, '&lt;')).join('\n')}</pre>
           <a href="${appUrl()}/admin/settings">Admin → Settings → Scheduled tasks</a>`,
  })
}
