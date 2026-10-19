import { NextResponse } from 'next/server'

// RETIRED. This endpoint marked a single commission paid on its own, which
// bypassed the payout-cycle system (migration 0034): a commission already
// batched into a payout could be marked paid here and then paid AGAIN when
// the whole payout was marked paid. Nothing in the admin UI calls it any
// more. Payouts are recorded per cycle via /api/admin/mark-payout-paid.
// This file can be deleted outright (`git rm`) — it only exists so the
// fix package can be applied as a plain tarball extract.
export async function POST() {
  return NextResponse.json(
    { error: 'This endpoint has been retired. Record payouts per cycle with /api/admin/mark-payout-paid.' },
    { status: 410 }
  )
}
