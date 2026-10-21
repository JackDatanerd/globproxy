import type { AdminSupabase } from '@/lib/adminAuth'
import { isUuid } from '@/lib/adminAuth'

// Shared by the audit-log page and its CSV export so both always show the
// same rows for the same filters.
export type AuditFilters = {
  action: string  // substring of the action name
  user: string    // exact target user id (links from a user page)
  who: string     // substring of the acting admin's OR the target's email
  from: string    // YYYY-MM-DD, inclusive
  to: string      // YYYY-MM-DD, inclusive
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function parseAuditFilters(get: (key: string) => string | undefined, clean: (v: string | undefined) => string): AuditFilters {
  const date = (k: string) => { const v = get(k) ?? ''; return DATE_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : '' }
  const user = get('user') ?? ''
  return { action: clean(get('q')), user: isUuid(user) ? user : '', who: clean(get('who')), from: date('from'), to: date('to') }
}

// Email search resolves to profile ids first (the log stores ids, not emails).
// The email search is capped at this many matching profiles (the ids travel in the
// query string). When it is hit the result is incomplete — callers must say so.
export const WHO_MATCH_CAP = 200

export async function resolveWhoIds(supabase: AdminSupabase, who: string): Promise<string[] | null> {
  if (!who) return null
  const { data } = await supabase.from('profiles').select('id').ilike('email', `%${who}%`).limit(WHO_MATCH_CAP)
  return (data ?? []).map(r => r.id)
}

export function applyAuditFilters<Q extends { ilike: any; eq: any; gte: any; lt: any; or: any }>(query: Q, f: AuditFilters, whoIds: string[] | null): Q {
  let q: any = query
  if (f.action) q = q.ilike('action', `%${f.action}%`)
  if (f.user) q = q.eq('target_user_id', f.user)
  if (whoIds) {
    // No matching account → match nothing (an empty IN list is a syntax error).
    const list = whoIds.length ? whoIds.join(',') : '00000000-0000-0000-0000-000000000000'
    q = q.or(`admin_id.in.(${list}),target_user_id.in.(${list})`)
  }
  if (f.from) q = q.gte('created_at', `${f.from}T00:00:00Z`)
  if (f.to) q = q.lt('created_at', new Date(Date.parse(`${f.to}T00:00:00Z`) + 86_400_000).toISOString())
  return q
}
