import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { isCrossSiteRequest } from '@/lib/appUrl'
import { rateLimitedUser } from '@/lib/rateLimit'
import { isUuid } from '@/lib/adminAuth'
import { NextResponse } from 'next/server'

// POST { order_id } — re-snapshot the customer's CURRENT billing details
// (company name, address, tax / VAT id from Billing → Invoice details) onto an
// invoice they were already issued. Invoices freeze the buyer's details when
// the order is paid, so someone who forgot their VAT id used to have to ask
// support. Only the buyer block changes — never the amounts, number or dates —
// it is capped at 3 revisions per invoice (reissue_invoice_details, migration
// 0057) and the invoice itself says it was revised.
export async function POST(req: Request) {
  if (isCrossSiteRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'invoice-details')
  if (throttled) return throttled
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request' }, { status: 400 }) }
  if (!isUuid(body?.order_id)) return NextResponse.json({ error: 'Invalid order' }, { status: 400 })

  const admin = await createAdminClient()
  const { data, error } = await admin.rpc('reissue_invoice_details', { p_order_id: body.order_id, p_user_id: user.id })
  if (error) {
    console.error('[invoice-details] reissue failed', error)
    return NextResponse.json({ error: 'Could not update the invoice. Please try again.' }, { status: 500 })
  }
  if (!data?.ok) {
    const msg =
      data?.reason === 'limit_reached' ? `This invoice has already been updated ${data?.limit ?? 3} times. Contact support@globproxy.com for further changes.` :
      data?.reason === 'no_invoice' ? 'This order has no invoice to update.' :
      data?.reason === 'not_found' ? 'Order not found.' :
      'Could not update the invoice.'
    return NextResponse.json({ error: msg }, { status: data?.reason === 'not_found' ? 404 : 409 })
  }
  return NextResponse.json({ ok: true, unchanged: !!data.unchanged, revision: data.revision })
}
