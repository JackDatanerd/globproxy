import type { AdminSupabase } from '@/lib/adminAuth'
import { fetchAllRows } from '@/lib/dbPaging'
import { VERIFIED_OPERATOR_REVIEW_DAYS } from '@/lib/rates'

// The Verified Operators who are due a review: approved, granted before the cutoff (or with
// no grant date recorded at all) and not reviewed since it. Same rule as
// verifiedOperatorReviewDue() in lib/rates.ts, computed as a set difference so one query
// pair covers every operator. Shared by the Overview tile, the affiliates "due" filter and
// the daily summary e-mail, which used to disagree or not exist.
export async function listVerifiedOperatorsDue(
  supabase: AdminSupabase, now: Date = new Date(),
): Promise<{ ids: string[]; error: string | null }> {
  const cutoff = new Date(now.getTime() - VERIFIED_OPERATOR_REVIEW_DAYS * 86_400_000).toISOString()
  const [ops, reviewed] = await Promise.all([
    fetchAllRows<{ id: string }>((from, to) => supabase.from('profiles').select('id')
      .eq('is_verified_operator', true).eq('affiliate_status', 'approved').eq('is_deleted', false)
      .or(`verified_operator_since.is.null,verified_operator_since.lte.${cutoff}`)
      .order('id').range(from, to)),
    fetchAllRows<{ user_id: string }>((from, to) => supabase.from('verified_operator_reviews').select('user_id')
      .gte('reviewed_at', cutoff).order('id').range(from, to)),
  ])
  if (ops.error || reviewed.error) return { ids: [], error: ops.error ?? reviewed.error }
  const recent = new Set(reviewed.rows.map(r => r.user_id))
  return { ids: ops.rows.filter(o => !recent.has(o.id)).map(o => o.id), error: null }
}
