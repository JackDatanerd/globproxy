import { createAdminClient } from '@/lib/supabase/server'
import { disableCredential, enableCredential } from '@/lib/adminProxy'
import { syncUserUsage } from '@/lib/usageSync'
import { dispatchWebhook } from '@/lib/webhooks'
import { getOwnedCredential } from '@/lib/credentials'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
type PauseResult =
  | { ok: true; data: { id: string; status: 'suspended' | 'active'; changed: boolean } }
  | { ok: false; status: number; code: 'not_found' | 'conflict' | 'forbidden' | 'upstream_unavailable'; message: string }

const fail = (status: number, code: 'not_found' | 'conflict' | 'forbidden' | 'upstream_unavailable', message: string): PauseResult => ({ ok: false, status, code, message })

async function ownerState(admin: Admin, userId: string) {
  const { data } = await admin.from('profiles').select('is_suspended, is_deleted').eq('id', userId).maybeSingle()
  return data as { is_suspended?: boolean; is_deleted?: boolean } | null
}

// Customer-initiated pause: the sub-user stops being able to use bandwidth (its
// upstream limit is capped at what it has used — the same mechanism an admin
// kill uses) while keeping its allocation, credentials and settings. Resume
// restores the limit. Idempotent: pausing a paused sub-user / resuming an
// active one answers ok with changed:false, so a retry after a timeout is safe.
// `usageSynced`: the caller already ran syncUserUsage for this account (bulk
// pauses do it once instead of once per sub-user — a sync walks every active
// sub-user against the provider).
export async function pauseCredential(admin: Admin, userId: string, id: string, opts: { usageSynced?: boolean } = {}): Promise<PauseResult> {
  const cred = await getOwnedCredential(admin, userId, id, 'id, label, status, suspended_reason, upstream_sub_user_id, gb_allocated')
  if (!cred) return fail(404, 'not_found', 'Sub-user not found')
  if (cred.status === 'suspended' && cred.suspended_reason === 'customer') return { ok: true, data: { id, status: 'suspended', changed: false } }
  if (cred.status !== 'active') return fail(409, 'conflict', `Only an active sub-user can be paused (status: ${cred.status}).`)
  // Bring usage up to date first (the usage sync only walks active sub-users).
  if (!opts.usageSynced) await syncUserUsage(userId).catch((e) => console.error('[pause] pre-pause usage sync failed', id, e))
  const fresh = await getOwnedCredential(admin, userId, id, 'id, label, status, upstream_sub_user_id, gb_allocated')
  if (!fresh || fresh.status !== 'active') return fail(409, 'conflict', `This sub-user changed while it was being paused (status: ${fresh?.status ?? 'gone'}). Check it and retry.`)
  try {
    await disableCredential(admin, fresh, 'customer')
  } catch (e) {
    console.error('[pause] disable failed', id, e)
    return fail(502, 'upstream_unavailable', 'Could not pause the sub-user right now. Nothing was changed — retry shortly.')
  }
  await dispatchWebhook(userId, 'session_suspended', { credential_id: id, label: cred.label ?? null, source: 'customer' })
  return { ok: true, data: { id, status: 'suspended', changed: true } }
}

export async function resumeCredential(admin: Admin, userId: string, id: string): Promise<PauseResult> {
  const cred = await getOwnedCredential(admin, userId, id, 'id, label, status, suspended_reason, upstream_sub_user_id, gb_allocated')
  if (!cred) return fail(404, 'not_found', 'Sub-user not found')
  if (cred.status === 'active') return { ok: true, data: { id, status: 'active', changed: false } }
  if (cred.status !== 'suspended') return fail(409, 'conflict', `Only a paused sub-user can be resumed (status: ${cred.status}).`)
  if (cred.suspended_reason !== 'customer') {
    return fail(403, 'forbidden', 'This sub-user was suspended by GlobProxy, not paused by you, so it cannot be resumed from the API. Contact support.')
  }
  const owner = await ownerState(admin, userId)
  if (owner?.is_deleted || owner?.is_suspended) return fail(403, 'forbidden', 'Your account is suspended. Contact support.')
  try {
    await enableCredential(admin, cred)
  } catch (e) {
    console.error('[pause] enable failed', id, e)
    return fail(502, 'upstream_unavailable', 'Could not resume the sub-user right now. Nothing was changed — retry shortly.')
  }
  await dispatchWebhook(userId, 'session_resumed', { credential_id: id, label: cred.label ?? null, source: 'customer' })
  return { ok: true, data: { id, status: 'active', changed: true } }
}
