import type { AdminSupabase } from '@/lib/adminAuth'

// Append-only record of admin actions (table: admin_audit_log, migration
// 0039). Best-effort by design — the action it describes has already
// happened by the time this runs, so a logging failure must never turn a
// successful suspend / payout / delete into an error response. Failures
// are logged loudly instead.
export async function logAdminAction(
  supabase: AdminSupabase,
  entry: {
    adminId: string
    action: string
    targetUserId?: string | null
    targetRef?: string | null
    details?: Record<string, unknown>
  }
): Promise<void> {
  try {
    const { error } = await supabase.from('admin_audit_log').insert({
      admin_id: entry.adminId,
      action: entry.action,
      target_user_id: entry.targetUserId ?? null,
      target_ref: entry.targetRef ?? null,
      details: entry.details ?? {},
    })
    if (error) console.error('[admin-audit] insert failed', entry.action, error)
  } catch (e) {
    console.error('[admin-audit] insert threw', entry.action, e)
  }
}
