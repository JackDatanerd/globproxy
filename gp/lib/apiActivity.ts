import { createAdminClient } from '@/lib/supabase/server'
import { applyCursor, cursorTs } from '@/lib/cursor'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// Reads api_request_log (written by withApiAuth for every mutating v1 call;
// pruned after 30 days). Shared by GET /api/v1/account/activity and the
// dashboard.
export async function listApiActivity(
  admin: Admin, userId: string, opts: { keyId?: string | null; limit?: number; before?: string | null; beforeId?: string | null }
): Promise<{ ok: true; data: { activity: any[]; has_more: boolean; next_before: string | null; next_before_id: string | null } } | { ok: false; status: number; message: string }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 200)
  let q = admin
    .from('api_request_log')
    .select('id, key_id, method, path, status, ip, request_id, created_at, key:key_id(key_prefix, label)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(limit + 1) // one extra row: tells us whether another page really exists
  if (opts.keyId) q = q.eq('key_id', opts.keyId)
  const cur = applyCursor(q, opts.before, opts.beforeId, 'int')
  if (!cur.ok) return { ok: false, status: 400, message: cur.message }
  q = cur.query
  const { data, error } = await q
  if (error) {
    // 22P02 = a non-uuid key_id filter.
    if (error.code === '22P02') return { ok: false, status: 400, message: 'key_id must be a valid key id.' }
    console.error('[api-activity] query failed', error)
    return { ok: false, status: 500, message: 'Could not load activity.' }
  }
  const fetched = data ?? []
  const hasMore = fetched.length > limit
  const rows = fetched.slice(0, limit).map((r: any) => ({
    id: r.id, key_id: r.key_id, key_prefix: r.key?.key_prefix ?? null, key_label: r.key?.label ?? null,
    method: r.method, path: r.path, status: r.status, ip: r.ip, request_id: r.request_id, created_at: r.created_at,
  }))
  return { ok: true, data: { activity: rows, has_more: hasMore, next_before: hasMore ? cursorTs(rows[rows.length - 1].created_at) : null, next_before_id: hasMore ? String(rows[rows.length - 1].id) : null } }
}
