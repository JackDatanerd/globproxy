import type { AdminSupabase } from '@/lib/adminAuth'
import { cancelInvitation } from '@/lib/resellerAllocation'

// Cancels every open (pending) invitation a reseller has sent, returning the reserved GB to
// their stock. Used when an admin removes reseller status: the claim function only checks
// that the sender is not suspended or deleted, so a demoted account's invitations would
// otherwise stay claimable, moving bandwidth on behalf of someone who is no longer a reseller.
// Failures are counted, never thrown — the role change has already happened.
export async function cancelOpenInvitations(
  supabase: AdminSupabase,
  reseller: { id: string; email: string | null; full_name: string | null },
): Promise<{ cancelled: number; failed: number; returnedGb: number }> {
  const { data, error } = await supabase.from('reseller_pending_transfers')
    .select('id').eq('reseller_id', reseller.id).eq('status', 'pending').limit(500)
  if (error) { console.error('[admin] could not list open invitations', reseller.id, error); return { cancelled: 0, failed: 1, returnedGb: 0 } }
  let cancelled = 0, failed = 0, returnedGb = 0
  for (const row of data ?? []) {
    const r = await cancelInvitation(supabase as any, { id: reseller.id, email: reseller.email, full_name: reseller.full_name } as any, row.id, 'support')
    if (r.ok) { cancelled++; returnedGb += r.data.returned_gb } else failed++
  }
  return { cancelled, failed, returnedGb }
}
