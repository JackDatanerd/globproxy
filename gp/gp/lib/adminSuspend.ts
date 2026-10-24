import { sendEmail, escapeHtml } from '@/lib/email'
import { adminNoticeHtml } from '@/lib/adminEmail'
import { disableUserCredentials, type ProxyToggleResult } from '@/lib/adminProxy'
import type { AdminSupabase } from '@/lib/adminAuth'

export const BAN_FOREVER = '876000h' // ~100 years — effectively permanent, reversible

export type SuspendResult =
  | { ok: true; proxy: ProxyToggleResult }
  | { ok: false; status: number; error: string }

// The suspend half of /api/admin/suspend-user, shared with "ban this address
// and suspend the account that uses it" (/api/admin/ban-email) so the two can
// never drift: profile flag, then auth ban (rolled back if it fails), then the
// live proxies. The caller has already decided the account may be suspended.
export async function suspendAccount(
  supabase: AdminSupabase,
  userId: string,
  reason: string
): Promise<SuspendResult> {
  const { error } = await supabase.from('profiles').update({
    is_suspended: true,
    suspended_at: new Date().toISOString(),
    suspension_reason: reason || 'Suspended by admin',
  }).eq('id', userId).or('is_suspended.is.null,is_suspended.eq.false')
  if (error) return { ok: false, status: 500, error: error.message }

  // supabase-js resolves with { error } rather than throwing; roll the flag
  // back so state never claims a ban that was not applied.
  const { error: banError } = await supabase.auth.admin.updateUserById(userId, { ban_duration: BAN_FOREVER })
  if (banError) {
    await supabase.from('profiles').update({ is_suspended: false, suspended_at: null, suspension_reason: null }).eq('id', userId)
    return { ok: false, status: 500, error: `Could not ban the auth account: ${banError.message}` }
  }

  // Stop live proxy traffic too. Partial failures are reported, not fatal.
  const proxy = await disableUserCredentials(supabase, userId)
  return { ok: true, proxy }
}

export async function sendSuspensionEmail(
  tp: { email: string | null; full_name: string | null },
  reason: string
): Promise<void> {
  if (!tp.email || tp.email === '[deleted]') return
  const name = escapeHtml(tp.full_name) || 'there'
  await sendEmail({
    to: tp.email,
    subject: 'Your GlobProxy account has been suspended',
    html: adminNoticeHtml({
      heading: 'Account suspended',
      bodyHtml: `Hi ${name}, your GlobProxy account has been suspended.${reason ? ` Reason: ${escapeHtml(reason)}.` : ''} If you believe this is a mistake, please contact us.`,
      cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
    }),
  }).catch((e) => console.error('[suspend] notification email failed:', e))
}
