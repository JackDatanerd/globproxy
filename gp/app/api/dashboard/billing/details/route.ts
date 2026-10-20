import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { isCrossSiteRequest } from '@/lib/appUrl'
import { rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// The buyer details printed on future invoices (company name is edited with the
// rest of the profile; this is the postal address and tax / VAT id). Orders
// snapshot these at the moment they are paid (claim_and_credit_order, migration
// 0047), so changing them never rewrites an invoice that was already issued.

const TAX_ID_RE = /^[A-Za-z0-9 .\-\/()+]*$/
const MAX_ADDRESS = 500
const MAX_TAX_ID = 64
const MAX_ADDRESS_LINES = 8

async function currentUser() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  return user
}

export async function GET(req: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const admin = await createAdminClient()
  const { data, error } = await admin.from('profiles').select('billing_address, tax_id').eq('id', user.id).maybeSingle()
  if (error) {
    console.error('[billing-details] load failed', error)
    return NextResponse.json({ error: 'Could not load your billing details.' }, { status: 500 })
  }
  return NextResponse.json({ billing_address: data?.billing_address ?? '', tax_id: data?.tax_id ?? '' })
}

export async function PUT(req: Request) {
  if (isCrossSiteRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  // Per-user throttle (lib/rateLimit.ts) — this route writes customer billing details on every call.
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'billing-details')
  if (throttled) return throttled
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request' }, { status: 400 }) }

  const rawAddress = typeof body?.billing_address === 'string' ? body.billing_address : ''
  const rawTax = typeof body?.tax_id === 'string' ? body.tax_id : ''

  // Strip control characters (keep newlines), tidy whitespace per line.
  const address = rawAddress
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .split('\n').map((l: string) => l.trim()).filter(Boolean).join('\n')
  const taxId = rawTax.trim()

  if (address.length > MAX_ADDRESS) return NextResponse.json({ error: `Address must be at most ${MAX_ADDRESS} characters.` }, { status: 400 })
  if (address.split('\n').length > MAX_ADDRESS_LINES) return NextResponse.json({ error: `Address can have at most ${MAX_ADDRESS_LINES} lines.` }, { status: 400 })
  if (taxId.length > MAX_TAX_ID) return NextResponse.json({ error: `Tax ID must be at most ${MAX_TAX_ID} characters.` }, { status: 400 })
  if (!TAX_ID_RE.test(taxId)) return NextResponse.json({ error: 'Tax ID may only contain letters, numbers, spaces and . - / ( ) +' }, { status: 400 })

  const admin = await createAdminClient()
  const { error } = await admin.from('profiles')
    .update({ billing_address: address || null, tax_id: taxId || null })
    .eq('id', user.id)
  if (error) {
    console.error('[billing-details] save failed', error)
    return NextResponse.json({ error: 'Could not save your billing details. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
