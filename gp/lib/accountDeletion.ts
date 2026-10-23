import { deleteSubUser, listAllSubUsers, GeonodeApiError } from '@/lib/geonode'
import type { AdminSupabase } from '@/lib/adminAuth'

// Used by app/api/admin/delete-user. It deliberately leaves an account in
// exactly the same end state as the self-service route
// (app/api/user/delete-account/route.ts): same fields wiped, same secrets
// purged, suspension state preserved. If you change one, change the other.

// Everything personal on the profile. Suspension fields are NOT touched: a
// suspended account that gets deleted must stay suspended (clearing them
// would turn a deletion into an unsuspend).
export function anonymisedProfilePatch(): Record<string, any> {
  return {
    full_name: '[deleted]',
    email: '[deleted]',
    company_name: null,
    billing_address: null,
    tax_id: null,
    is_deleted: true,
    deleted_at: new Date().toISOString(),
    api_access: false,
    reseller_application: null,
    affiliate_application: null,
    api_access_application: null,
    payout_method: null,
    payout_wallet_address: null,
    payout_wallet_network: null,
    payout_bank_details: null,
    payout_mpesa_phone: null,
    payout_method_updated_at: null,
    payout_hold_reason: null,
    mfa_enabled: false,
    // A deleted account must not keep the Verified Operator badge (it still
    // counted in operator lists and stats). The flag and its rate bookkeeping.
    is_verified_operator: false,
    verified_operator_since: null,
    verified_operator_prev_rate: null,
    verified_operator_prev_rate_lifetime: null,
  }
}

// Restores exactly the columns anonymisedProfilePatch() cleared, from a full
// pre-deletion `select('*')`. Used if the auth ban fails afterwards.
export function rollbackProfilePatch(before: Record<string, any>): Record<string, any> {
  const restore: Record<string, any> = {}
  for (const key of Object.keys(anonymisedProfilePatch())) {
    restore[key] = before[key] ?? (key === 'api_access' || key === 'mfa_enabled' || key === 'is_verified_operator' ? false : null)
  }
  restore.is_deleted = false
  restore.deleted_at = null
  return restore
}

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

// Releases every listed Geonode sub-user. A 404 means it is already gone (a
// retry after a partial run) and counts as released. Each released credential
// is tombstoned locally AT ONCE (stored password and Geonode ids dropped,
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
export async function releaseGeonodeSubUsers(
  supabase: AdminSupabase,
  creds: ReleasableCredential[]
): Promise<{ released: string[]; failed: { id: string; error: string }[] }> {
  const released: string[] = []
  const failed: { id: string; error: string }[] = []
  let listing: Awaited<ReturnType<typeof listAllSubUsers>> | null = null
  for (const cred of creds) {
    let subUserId = cred.upstream_sub_user_id
    try {
      if (!subUserId && cred.provision_username) {
        listing ??= await listAllSubUsers()
        for (const [id, snap] of listing.subUsers) if (snap.username === cred.provision_username) { subUserId = id; break }
        if (!subUserId && !listing.complete) throw new Error('supplier sub-user listing incomplete — cannot confirm the reserved sub-user does not exist')
      }
      if (subUserId) await deleteSubUser(subUserId)
    } catch (e: any) {
      if (!(e instanceof GeonodeApiError && e.status === 404)) {
        console.error('Failed to clean up Geonode sub-user during account deletion', cred.id, e)
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
    if (error) console.error('[accountDeletion] could not tombstone released credential', cred.id, error)
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
// credentials read as inactive and lose their stored password / Geonode ids
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
    const { failed } = await releaseGeonodeSubUsers(supabase, remaining)
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
