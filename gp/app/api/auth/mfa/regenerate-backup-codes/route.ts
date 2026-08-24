import { createClient, createAdminClient } from '@/lib/supabase/server'
import { regenerateBackupCodes } from '@/lib/mfa'
import { sendEmail, securityNoticeHtml, escapeHtml } from '@/lib/email'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { code } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter your current code or a backup code to confirm.' }, { status: 400 })
  }

  try {
    const backup_codes = await regenerateBackupCodes(user.id, user.email, code)
    // Lower urgency than enable/disable — 2FA itself stays on either way —
    // but still a silent invalidation of every existing backup code, so
    // still worth the same trip-wire pattern. Fire-and-forget.
    const admin = await createAdminClient()
    const { data: profile } = await admin.from('profiles').select('full_name').eq('id', user.id).single()
    sendEmail({
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
    }).catch(() => {})
    return NextResponse.json({ backup_codes })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not regenerate backup codes.' }, { status: 400 })
  }
}
