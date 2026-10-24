// Pure (import-free) so it can be unit-tested with `node --test` — see tests/.
// Re-exported from lib/accountDeletion.ts, which is what the routes import.

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
