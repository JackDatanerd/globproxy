import { NextResponse } from 'next/server'
import type { AdminSupabase } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { adminNoticeHtml } from '@/lib/adminEmail'

type StatusColumn = 'affiliate_status' | 'reseller_status' | 'api_access_status'

// Shared body of the six approve/reject routes (reseller, affiliate, API
// access). The "still pending" condition is part of the UPDATE itself —
// they used to read the status, then update without re-checking it, so two
// admins (or a double-click) could both pass the check and the second
// write silently won. Deleted accounts are excluded too, and callers can
// add equality guards (e.g. role) that must also hold.
export async function resolvePendingApplication(opts: {
  supabase: AdminSupabase
  adminId: string
  userId: string
  statusColumn: StatusColumn
  updates: Record<string, any>
  requireRole?: 'user' | 'reseller'
  audit: { action: string; details?: Record<string, unknown> }
  // Optional note written by the admin: shown to the applicant in the email
  // and kept in the audit log.
  reason?: string | null
  email: { subject: string; heading: string; body: (firstName: string) => string; cta: { href: string; label: string } }
}): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const { supabase, adminId, userId, statusColumn, requireRole, audit, email, reason } = opts

  // Stamp WHEN a rejection happened: the 7-day re-apply cooldown (apply-reseller /
  // apply-affiliate) counts from the review, not from the original submission.
  // API-access requests have the same cooldown (api_access_rejected_at, 0052) —
  // each submit emails an admin, so without it one reseller could flood the inbox.
  const updates: Record<string, any> = { ...opts.updates }
  if (updates[statusColumn] === 'rejected') {
    if (statusColumn === 'reseller_status') updates.reseller_rejected_at = new Date().toISOString()
    if (statusColumn === 'affiliate_status') updates.affiliate_rejected_at = new Date().toISOString()
    if (statusColumn === 'api_access_status') updates.api_access_rejected_at = new Date().toISOString()
  }

  let q = supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .eq(statusColumn, 'pending')
    .eq('is_deleted', false)
    .neq('role', 'admin') // an approve/reject must never touch an admin's role or status
  if (requireRole) q = q.eq('role', requireRole)

  const { data: applicant, error } = await q.select('email, full_name').maybeSingle()
  if (error) return { ok: false, response: NextResponse.json({ error: error.message }, { status: 500 }) }
  if (!applicant) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'This request has already been resolved, or no longer applies to this account.' }, { status: 409 }),
    }
  }

  await logAdminAction(supabase, { adminId, action: audit.action, targetUserId: userId, details: { ...(audit.details ?? {}), ...(reason ? { reason } : {}) } })

  if (applicant.email && applicant.email !== '[deleted]') {
    const firstName = escapeHtml(applicant.full_name?.split(' ')[0]) || 'there'
    await sendEmailSafe({
      to: applicant.email,
      subject: email.subject,
      html: adminNoticeHtml({ heading: email.heading, bodyHtml: email.body(firstName) + (reason ? `<br/><br/><strong>Note from our team:</strong> ${escapeHtml(reason)}` : ''), cta: email.cta }),
    })
  }

  return { ok: true }
}

// Optional free-text rejection note from the admin UI: trimmed, capped, and
// null when absent. Returns undefined for a value of the wrong type so the
// caller can answer 400.
export function cleanReason(v: unknown): string | null | undefined {
  if (v == null || v === '') return null
  if (typeof v !== 'string') return undefined
  const t = v.trim().replace(/\s+/g, ' ')
  return t ? t.slice(0, 500) : null
}
