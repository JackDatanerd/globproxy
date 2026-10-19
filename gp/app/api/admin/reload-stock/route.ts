import { authorizeAdmin, readJson, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { purchaseBandwidth } from '@/lib/geonode'
import { sendEmailSafe } from '@/lib/email'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response

  const body = await readJson<{ gb_amount?: unknown }>(req)
  const gb = body?.gb_amount
  // typeof check first: a string such as "abc" slipped through the old
  // `gb_amount < 100` comparison (NaN < 100 is false).
  if (typeof gb !== 'number' || !Number.isFinite(gb) || gb < 100 || gb > 1_000_000) {
    return badRequest('gb_amount must be a number between 100 and 1,000,000')
  }

  try {
    await purchaseBandwidth(gb)
  } catch (err: any) {
    // purchaseBandwidth is currently disabled — Geonode's reseller API has no
    // documented purchase endpoint. See lib/geonode.ts for details.
    return NextResponse.json({ error: err.message }, { status: 501 })
  }

  // Past this point the purchase has happened. A failed notification must
  // not turn that into an error response (it used to land in the same
  // catch and read as "purchase failed").
  await logAdminAction(auth.supabase, { adminId: auth.adminId, action: 'stock.reload', details: { gb_amount: gb } })
  await sendEmailSafe({
    to: process.env.ADMIN_EMAIL ?? 'admin@globproxy.com',
    subject: `Stock reloaded: ${gb}GB — GlobProxy`,
    html: `<p>Your bandwidth stock has been reloaded with <strong>${gb} GB</strong>.</p>`,
  })
  return NextResponse.json({ success: true, gb_amount: gb })
}
