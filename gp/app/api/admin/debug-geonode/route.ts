import { createAdminClient } from '@/lib/supabase/server'
import { debugCreateSubUser, getAccountBalance } from '@/lib/geonode'
import { NextResponse } from 'next/server'

// Admin-only diagnostic endpoint — OFF by default. Even though it's
// admin-gated, this makes real, live calls against production Geonode
// (creating and deleting a real sub-user on every POST) and previously
// echoed back partial GEONODE_API_KEY bytes, which is more than a debug
// endpoint should expose even to admins. It now requires
// ENABLE_DEBUG_ENDPOINTS=true to respond at all, and no longer returns any
// part of the raw API key — only whether it's present/absent and its length.
// GET  — tests the balance/stock endpoint (read-only, no side effects)
// POST — creates a 10 MB test sub-user, captures the full raw Geonode response,
//        then immediately deletes it. Use this to verify:
//          1. The API key and reseller ID are valid
//          2. The exact field names Geonode uses in the response (id vs sub_user_id, etc.)
//          3. That bandwidth_limit_mb is the correct request field name
//        Check `raw_response` in the returned JSON if `parsed_gcred` fields look wrong.
// NOTE: auth header confirmed from the live OpenAPI spec to be the custom
// header "Reseller-Api-Key: <key>" — not "r-api-key", not "Authorization:
// Bearer". Both of those were tried against production and failed first.
// See lib/geonode.ts headers().

function debugEndpointsEnabled() {
  return process.env.ENABLE_DEBUG_ENDPOINTS === 'true'
}

async function verifyAdmin(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null

  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  return profile?.role === 'admin' ? user : null
}

// GET — balance check (safe, read-only)
export async function GET(req: Request) {
  if (!debugEndpointsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const user = await verifyAdmin(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = process.env.GEONODE_API_KEY
  const resellerId = process.env.GEONODE_RESELLER_ID

  const env = {
    api_key_present: !!apiKey,
    api_key_length: apiKey?.length ?? 0,
    reseller_id_present: !!resellerId,
  }

  try {
    const balance = await getAccountBalance()
    return NextResponse.json({ env, balance, status: 'ok' })
  } catch (err: any) {
    return NextResponse.json({ env, error: err.message, status: 'failed' }, { status: 500 })
  }
}

// POST — test sub-user creation (creates 10 MB sub-user, captures raw response, deletes it)
export async function POST(req: Request) {
  if (!debugEndpointsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const user = await verifyAdmin(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await debugCreateSubUser()
    return NextResponse.json({
      ...result,
      status: result.error ? 'failed' : 'ok',
      note: result.error
        ? 'Sub-user creation failed. Check raw_response for the exact Geonode error.'
        : result.cleanup_deleted
          ? 'Sub-user created and deleted successfully.'
          : 'Sub-user created but cleanup delete failed — check Geonode dashboard for orphan.',
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message, status: 'failed' }, { status: 500 })
  }
}
