import { anyLeaksSupplier, SUPPLIER_TEXT_ERROR } from '@/lib/supplierGuard'
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
  if (anyLeaksSupplier(reason)) return badRequest(SUPPLIER_TEXT_ERROR)

  // Only reseller_status changes. The old version also hard-set
  // role: 'user', which would strip the role from any account that wasn't
  // actually a plain user when its application was rejected.
  const result = await resolvePendingApplication({
    supabase: auth.supabase, adminId: auth.adminId, userId: body.userId,
    statusColumn: 'reseller_status',
    updates: { reseller_status: 'rejected' },
    reason,
    audit: { action: 'reseller.reject' },
    email: {
      subject: 'Update on your GlobProxy reseller application',
      heading: 'Reseller application update',
      body: (n) => `Hi ${n}, we're not able to approve your reseller application at this time. You're welcome to continue using GlobProxy as a regular customer, or reach out to support if you'd like to discuss reapplying.`,
      cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
    },
  })
  return result.ok ? NextResponse.json({ success: true }) : result.response
}
