import type { AdminSupabase } from '@/lib/adminAuth'
import { getSubUserUsage, updateSubUserTrafficLimit } from '@/lib/upstream'
import { syncUserUsage } from '@/lib/usageSync'
import { dispatchWebhook } from '@/lib/webhooks'

// Suspending an account used to block the dashboard and the API but leave
// every live upstream sub-user working — a suspended abuser kept proxying
// until their bandwidth ran out. upstream has no "disable" call, so the
// effective switch is capping the sub-user's traffic limit at what it has
// already used (floored at 1 MB — 0 might read as "unlimited") and
// marking the credential 'suspended' locally. Re-enabling restores the
// limit from gb_allocated, which top-ups already keep equal to the limit.
//
// NOTE: the cap is applied to the sub-user's cumulative counter. It never
// touches activeUntil (that would reset usage — see upstream.ts).

type CredRow = { id: string; upstream_sub_user_id: string | null; gb_allocated: number | string | null; status: string; label?: string | null }

export type ProxyToggleResult = { changed: number; failed: { id: string; error: string }[]; kept_disabled?: number }

// Why a credential is 'suspended' (proxy_credentials.suspended_reason, 0052).
// Re-enabling an ACCOUNT only restores credentials that the account suspension
// itself disabled: one an admin killed individually ('admin') stays off, and a
// deleted account's ('deleted') never comes back. NULL = suspended before the
// column existed, treated as account-level (the old behaviour).
// 'customer' = the owner paused it themselves (POST /api/v1/sub-users/:id/pause);
// only the owner can resume it, and an account re-enable never touches it.
export type SuspendReason = 'account' | 'admin' | 'customer'

export async function disableCredential(supabase: AdminSupabase, cred: CredRow, reason: SuspendReason = 'admin'): Promise<void> {
  if (cred.upstream_sub_user_id) {
    const usedGb = await getSubUserUsage(cred.upstream_sub_user_id)
    await updateSubUserTrafficLimit(cred.upstream_sub_user_id, Math.max(1, Math.ceil(usedGb * 1024)))
  }
  const { error } = await supabase.from('proxy_credentials').update({ status: 'suspended', suspended_reason: reason }).eq('id', cred.id)
  if (error) throw new Error(error.message)
}

// Thrown when re-activating would push the account past its live-session cap (the
// database trigger, migration 0083). A caller maps it to a 409 instead of a 500.
export class SessionLimitError extends Error {
  constructor() { super('Session limit reached (100). Delete an unused session first.'); this.name = 'SessionLimitError' }
}

// The database row is activated FIRST so the session-cap trigger can refuse it BEFORE
// the upstream cap is lifted. The other order lifted the cap, then failed on the cap
// trigger: the session kept proxying upstream while it still read "paused" here — and
// the usage sync never walks a suspended session, so nothing was ever counted or billed.
// If the upstream call then fails, the row is put back to its previous suspended state — including a
// NULL reason (suspended before the column existed = account-level), which must not become 'admin',
// or a later account re-enable would never touch it again.
export async function enableCredential(supabase: AdminSupabase, cred: CredRow & { suspended_reason?: string | null }): Promise<void> {
  const { error } = await supabase.from('proxy_credentials')
    .update({ status: 'active', suspended_reason: null }).eq('id', cred.id).eq('status', 'suspended')
  if (error) {
    if ((error as any).code === '23514') throw new SessionLimitError()
    throw new Error(error.message)
  }
  if (cred.upstream_sub_user_id) {
    try {
      await updateSubUserTrafficLimit(cred.upstream_sub_user_id, Math.round(Number(cred.gb_allocated ?? 0) * 1024))
    } catch (e) {
      const { error: revertErr } = await supabase.from('proxy_credentials')
        .update({ status: 'suspended', suspended_reason: cred.suspended_reason ?? null }).eq('id', cred.id)
      if (revertErr) console.error('[admin-proxy] could not put a failed re-enable back to suspended', cred.id, revertErr)
      throw e
    }
  }
}

export async function disableUserCredentials(supabase: AdminSupabase, userId: string): Promise<ProxyToggleResult> {
  // Bring gb_used / the account balance up to date first, so usage between
  // the last cron tick and now isn't lost once the credential stops being
  // 'active' (the usage sync only walks active credentials).
  await syncUserUsage(userId).catch((e) => console.error('[admin-proxy] pre-suspend usage sync failed', userId, e))

  const { data: creds } = await supabase
    .from('proxy_credentials')
    .select('id, upstream_sub_user_id, gb_allocated, status, label')
    .eq('user_id', userId)
    .eq('status', 'active')

  const result: ProxyToggleResult = { changed: 0, failed: [] }
  for (const cred of creds ?? []) {
    try {
      await disableCredential(supabase, cred, 'account')
      result.changed++
      // The owner's integrations hear about it (deferred: one first-attempt per
      // credential inline could stall the admin request on a slow endpoint).
      await dispatchWebhook(userId, 'session_suspended', { credential_id: cred.id, label: cred.label ?? null, source: 'account' }, { defer: true })
    } catch (e: any) {
      console.error('[admin-proxy] failed to disable credential', cred.id, e)
      result.failed.push({ id: cred.id, error: e?.message ?? 'unknown error' })
    }
  }
  return result
}

export async function enableUserCredentials(supabase: AdminSupabase, userId: string): Promise<ProxyToggleResult> {
  const { data: creds } = await supabase
    .from('proxy_credentials')
    .select('id, upstream_sub_user_id, gb_allocated, status, label, suspended_reason')
    .eq('user_id', userId)
    .eq('status', 'suspended')
    .or('suspended_reason.is.null,suspended_reason.eq.account')

  // Credentials an admin disabled one by one stay disabled — reported so the
  // admin knows they have to be re-enabled deliberately.
  const { count: keptDisabled } = await supabase
    .from('proxy_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'suspended')
    .eq('suspended_reason', 'admin')

  const result: ProxyToggleResult = { changed: 0, failed: [], kept_disabled: keptDisabled ?? 0 }
  for (const cred of creds ?? []) {
    try {
      await enableCredential(supabase, cred)
      result.changed++
      await dispatchWebhook(userId, 'session_resumed', { credential_id: cred.id, label: cred.label ?? null, source: 'account' }, { defer: true })
    } catch (e: any) {
      console.error('[admin-proxy] failed to re-enable credential', cred.id, e)
      result.failed.push({ id: cred.id, error: e?.message ?? 'unknown error' })
    }
  }
  return result
}
