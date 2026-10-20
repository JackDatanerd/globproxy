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
    statusColumn: 'api_access_status',
    updates: { api_access_status: 'rejected' },
    reason,
    audit: { action: 'api_access.reject' },
    email: {
      subject: 'Update on your GlobProxy API access request',
      heading: 'API access request update',
      body: (n) => `Hi ${n}, we're not able to approve your API access request at this time. Your reseller account is unaffected — reach out to support if you'd like to discuss your use case or reapply.`,
      cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
    },
  })
  return result.ok ? NextResponse.json({ success: true }) : result.response
}
