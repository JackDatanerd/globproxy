import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { resolvePendingApplication, cleanReason } from '@/lib/adminApplications'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const body = await readJson<{ userId?: string; reason?: unknown }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')
  const reason = cleanReason(body.reason)
  if (reason === undefined) return badRequest('reason must be text')

  const result = await resolvePendingApplication({
    supabase: auth.supabase, adminId: auth.adminId, userId: body.userId,
    statusColumn: 'affiliate_status',
    updates: { affiliate_status: 'rejected' },
    reason,
    audit: { action: 'affiliate.reject' },
    email: {
      subject: 'Update on your GlobProxy affiliate application',
      heading: 'Affiliate application update',
      body: (n) => `Hi ${n}, we're not able to approve your affiliate application at this time. You can still refer friends for the standard bandwidth-credit reward, and you're welcome to reach out to support if you'd like to discuss reapplying.`,
      cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
    },
  })
  return result.ok ? NextResponse.json({ success: true }) : result.response
}
