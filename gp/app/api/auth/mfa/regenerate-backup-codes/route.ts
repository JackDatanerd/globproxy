import { createClient, createAdminClient } from '@/lib/supabase/server'
import { regenerateBackupCodes, publicMfaError } from '@/lib/mfa'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimited } from '@/lib/rateLimit'
import { sendEmailSafe, securityNoticeHtml, escapeHtml } from '@/lib/email'
import { logSecurityEvent } from '@/lib/securityEvents'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'mfa')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  const { code } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter your current code or a backup code to confirm.' }, { status: 400 })
  }

  try {
    const backup_codes = await regenerateBackupCodes(user.id, user.email, code, req)
    await logSecurityEvent({ userId: user.id, event: 'mfa_backup_regenerated', req })

    // Lower urgency than enable/disable, but still a silent invalidation of
    // every existing backup code — same trip-wire pattern, awaited.
    const admin = await createAdminClient()
    const { data: profile } = await admin.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
    await sendEmailSafe({
      to: user.email,
      subject: 'Your GlobProxy backup codes were regenerated',
      html: securityNoticeHtml({
        heading: 'Backup codes regenerated',
        bodyHtml: `
          <p style="color:#444;text-align:center;">
            Hi ${escapeHtml(profile?.full_name) || 'there'}, this confirms new two-factor backup codes were just
            generated for your GlobProxy account (${escapeHtml(user.email)}). Your old backup codes no longer work.
            If you made this change, no action is needed.
          </p>
          <p style="color:#444;text-align:center;">
            If you didn't make this change, contact support immediately.
          </p>
          <p style="color:#888;font-size:13px;text-align:center;">
            <a href="mailto:support@globproxy.com" style="color:#2563eb;">Contact support</a>.
          </p>`,
      }),
    })
    return NextResponse.json({ backup_codes })
  } catch (e: any) {
    return NextResponse.json({ error: publicMfaError(e, 'Could not regenerate backup codes.') }, { status: 400 })
  }
}
