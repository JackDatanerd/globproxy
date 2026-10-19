import { createAdminClient } from '@/lib/supabase/server'
import { deleteSubUser, getSubUserUsage, GeonodeApiError } from '@/lib/geonode'

// Shared by the dashboard and v1 credential-DELETE routes so the two can't
// drift. All writes go through the service-role client + delete_own_credential()
// (migration 0040): end users no longer have any write path to
// proxy_credentials or the reservation counters.

export const MIN_GB = 0.01
export const MAX_GB = 100000

// Parses a client-supplied GB amount. Rejects strings like "1e9999",
// NaN/Infinity, and anything that would round to 0 MB at Geonode (a 0 MB
// cap risks being read upstream as "unlimited").
export function parseGb(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < MIN_GB || n > MAX_GB) return null
  return Math.round(n * 1e6) / 1e6
}

type CredForDelete = {
  id: string
  geonode_sub_user_id: string | null
  gb_used: number | null
}

export type DeleteCredentialResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export async function deleteOwnCredential(userId: string, cred: CredForDelete): Promise<DeleteCredentialResult> {
  const admin = await createAdminClient()

  // Live usage BEFORE deleting the sub-user — it may not be queryable after.
  let liveUsedGb: number | null = null
  if (cred.geonode_sub_user_id) {
    try { liveUsedGb = await getSubUserUsage(cred.geonode_sub_user_id) }
    catch (e) { console.error('[credential delete] live usage check failed (falling back to synced gb_used):', e) }

    // The sub-user must really be gone before we hand any reservation back.
    // Previously a failed Geonode delete was swallowed, the row was removed
    // and the unused GB released while the sub-user stayed alive and usable
    // — free bandwidth. 404 = already gone upstream, which is fine.
    try { await deleteSubUser(cred.geonode_sub_user_id) }
    catch (e) {
      const gone = e instanceof GeonodeApiError && e.status === 404
      if (!gone) {
        console.error('[credential delete] Geonode delete failed — aborting, nothing changed locally:', e)
        return { ok: false, status: 502, error: 'Could not remove this session from the proxy network right now. Please try again shortly.' }
      }
    }
  }

  const { error } = await admin.rpc('delete_own_credential', {
    p_credential_id: cred.id,
    p_user_id: userId,
    p_live_used_gb: liveUsedGb,
  })
  if (error) {
    console.error('[credential delete] delete_own_credential failed:', error)
    return { ok: false, status: 500, error: 'Could not delete this session. Please try again.' }
  }
  return { ok: true }
}
