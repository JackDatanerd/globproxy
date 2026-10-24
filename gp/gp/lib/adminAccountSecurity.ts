import type { AdminSupabase } from '@/lib/adminAuth'

// Revoke every live API key a user holds. API access used to be switched off
// only at request time (profiles.api_access), which left the keys themselves
// valid: re-granting access later — or promoting the account back to reseller —
// quietly brought every old key back to life. Revoking the rows makes "access
// removed" mean the keys are gone for good; a new key has to be generated.
export async function revokeAllApiKeys(
  supabase: AdminSupabase,
  userId: string
): Promise<{ ok: boolean; revoked: number; error?: string }> {
  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id')
  if (error) {
    console.error('[admin] revoking API keys failed', userId, error)
    return { ok: false, revoked: 0, error: error.message }
  }
  return { ok: true, revoked: data?.length ?? 0 }
}

// End every login session of an account, and report whether that worked.
// (lib/mfa.revokeOtherSessions does the same RPC but swallows a failure — fine
// for self-service flows, wrong for an admin acting on a suspected takeover:
// the admin and the audit log would both read "done" when it wasn't.)
// Note a session's already-issued access token stays valid until it expires
// (≤ 1 h); the refresh token — what keeps a stolen session alive — is gone.
export async function revokeAllSessions(
  supabase: AdminSupabase,
  userId: string
): Promise<{ ok: boolean; revoked: number; error?: string }> {
  const { data, error } = await supabase.rpc('revoke_other_auth_sessions', { p_user_id: userId, p_keep: null })
  if (error) {
    console.error('[admin] revoking sessions failed', userId, error)
    return { ok: false, revoked: 0, error: error.message }
  }
  return { ok: true, revoked: typeof data === 'number' ? data : 0 }
}
