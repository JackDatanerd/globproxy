import { deleteSubUser, GeonodeApiError } from '@/lib/geonode'
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
    mfa_enabled: false,
  }
}

// Restores exactly the columns anonymisedProfilePatch() cleared, from a full
// pre-deletion `select('*')`. Used if the auth ban fails afterwards.
export function rollbackProfilePatch(before: Record<string, any>): Record<string, any> {
  const restore: Record<string, any> = {}
  for (const key of Object.keys(anonymisedProfilePatch())) {
    restore[key] = before[key] ?? (key === 'api_access' || key === 'mfa_enabled' ? false : null)
  }
  restore.is_deleted = false
  restore.deleted_at = null
  return restore
}

// Deletes every listed Geonode sub-user and returns the ones that FAILED. A
// 404 means it's already gone (a retry after a partial run) and counts as
// success. Callers must abort before touching local rows if anything fails —
// swallowing the error leaves a real, billable, still-working sub-user
// behind an account that reads as deleted.
export async function cleanupGeonodeSubUsers(
  creds: { id: string; upstream_sub_user_id: string | null }[]
): Promise<{ id: string; error: string }[]> {
  const failed: { id: string; error: string }[] = []
  for (const cred of creds) {
    if (!cred.upstream_sub_user_id) continue
    try {
      await deleteSubUser(cred.upstream_sub_user_id)
    } catch (e: any) {
      if (e instanceof GeonodeApiError && e.status === 404) continue
      console.error('Failed to clean up Geonode sub-user during account deletion', cred.id, e)
      failed.push({ id: cred.id, error: String(e?.message ?? e) })
    }
  }
  return failed
}

// Everything after the profile is anonymised and the auth account banned:
// credentials read as inactive and lose their stored password / Geonode ids,
// secrets with no accounting value are deleted, API keys are revoked.
// Orders, invoices and ledgers are kept for accounting.
export async function purgeAccountSecrets(supabase: AdminSupabase, userId: string, hadCredentials: boolean): Promise<void> {
  if (hadCredentials) {
    await supabase.from('proxy_credentials')
      .update({ status: 'suspended', upstream_password: null, upstream_username: null, upstream_sub_user_id: null })
      .eq('user_id', userId)
  }
  await supabase.from('webhook_endpoints').delete().eq('user_id', userId)
  await supabase.from('mfa_totp_factors').delete().eq('user_id', userId)
  await supabase.from('mfa_backup_codes').delete().eq('user_id', userId)
  await supabase.from('mfa_verified_sessions').delete().eq('user_id', userId)
  await supabase.from('support_reports').update({ email: '[deleted]' }).eq('user_id', userId)
  await supabase.from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null)

  // Affiliate side (migration 0044): suspend the affiliate status so nothing new
  // accrues to a deleted account, and forfeit UNBATCHED earnings. Already-batched
  // / paid payout rows are kept — they're financial records. Idempotent.
  const { error: scrubErr } = await supabase.rpc('scrub_affiliate_data', { p_user_id: userId })
  if (scrubErr) console.error('[accountDeletion] scrub_affiliate_data failed', userId, scrubErr)
}
