import type { AdminSupabase } from '@/lib/adminAuth'
import { isUuid, isIsoDate } from '@/lib/adminAuth'

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
  const date = (k: string) => { const v = get(k) ?? ''; return isIsoDate(v) ? v : '' }
  const user = get('user') ?? ''
  return { action: clean(get('q')), user: isUuid(user) ? user : '', who: clean(get('who')), from: date('from'), to: date('to') }
}

export type AuditRow = {
  id: string; action: string; target_ref: string | null; target_user_id: string | null
  details: Record<string, unknown> | null; created_at: string
  admin: { email: string | null } | null; target: { email: string | null } | null
}

// One database function (migration 0085) filters, joins both e-mail addresses and pages the
// result. The old approach resolved "who" to a list of profile ids and sent them in the URL —
// capped at 200 accounts and, at that size, too long for the gateway, so a broad search failed.
// `limit`/`offset` page the result; `count` is the total before paging.
export async function searchAuditLog(
  supabase: AdminSupabase, f: AuditFilters, page: { limit: number; offset: number },
): Promise<{ rows: AuditRow[]; count: number; error: string | null }> {
  const { data, error } = await supabase.rpc('admin_audit_search', {
    p_action: f.action || null,
    p_user: f.user || null,
    p_who: f.who || null,
    p_from: f.from ? `${f.from}T00:00:00Z` : null,
    p_to: f.to ? new Date(Date.parse(`${f.to}T00:00:00Z`) + 86_400_000).toISOString() : null,
    p_limit: page.limit,
    p_offset: page.offset,
  })
  if (error) return { rows: [], count: 0, error: error.message }
  const raw = (data ?? []) as any[]
  const rows: AuditRow[] = raw.map(r => ({
    id: r.id, action: r.action, target_ref: r.target_ref, target_user_id: r.target_user_id,
    details: r.details, created_at: r.created_at,
    admin: r.admin_email != null ? { email: r.admin_email } : null,
    target: r.target_email != null ? { email: r.target_email } : null,
  }))
  return { rows, count: raw.length ? Number(raw[0].total_count) : 0, error: null }
}
