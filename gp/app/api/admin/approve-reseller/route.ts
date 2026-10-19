import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { resolvePendingApplication } from '@/lib/adminApplications'
import { appUrl } from '@/lib/adminEmail'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const body = await readJson<{ userId?: string }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')

  // requireRole: 'user' — an approval writes role = 'reseller', so it must
  // only ever run on an ordinary account. (Without it, an admin who ended
  // up with reseller_status = 'pending' would be DEMOTED by an approval.)
  const result = await resolvePendingApplication({
    supabase: auth.supabase, adminId: auth.adminId, userId: body.userId,
    statusColumn: 'reseller_status', requireRole: 'user',
    updates: { role: 'reseller', reseller_status: 'approved' },
    audit: { action: 'reseller.approve' },
    email: {
      subject: 'Your GlobProxy reseller application was approved',
      heading: 'Reseller application approved ✓',
      body: (n) => `Hi ${n}, your reseller application has been approved. You can now allocate bandwidth to your clients from your dashboard.`,
      cta: { href: `${appUrl()}/reseller`, label: 'Go to reseller dashboard →' },
    },
  })
  return result.ok ? NextResponse.json({ success: true }) : result.response
}
