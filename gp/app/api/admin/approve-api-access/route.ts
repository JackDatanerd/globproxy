import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { resolvePendingApplication } from '@/lib/adminApplications'
import { appUrl } from '@/lib/adminEmail'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const body = await readJson<{ userId?: string }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')

  // API access only applies to reseller accounts (lib/apiAuth.ts rejects
  // anyone else regardless), so the role is part of the UPDATE condition.
  const result = await resolvePendingApplication({
    supabase: auth.supabase, adminId: auth.adminId, userId: body.userId,
    statusColumn: 'api_access_status', requireRole: 'reseller',
    updates: { api_access: true, api_access_status: 'approved' },
    audit: { action: 'api_access.approve' },
    email: {
      subject: 'Your GlobProxy API access request was approved',
      heading: 'API access approved ✓',
      body: (n) => `Hi ${n}, your API access request has been approved. Head to API Keys in your dashboard to generate a key and get started.`,
      cta: { href: `${appUrl()}/dashboard/api-keys`, label: 'Go to API Keys →' },
    },
  })
  return result.ok ? NextResponse.json({ success: true }) : result.response
}
