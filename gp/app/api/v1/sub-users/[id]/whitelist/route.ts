import { withApiAuth, readJsonBody } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { listWhitelistedIps, addWhitelistedIp, removeWhitelistedIp } from '@/lib/geonode'
import { isValidIp, validateIpForAdd, validateDescription, notifyWhitelistChanged } from '@/lib/ipWhitelist'
import { getOwnedCredential } from '@/lib/credentials'
import { mirrorWhitelist, whitelistFailure } from '@/lib/whitelistMirror'
import { NextResponse } from 'next/server'

// Mirrors app/api/dashboard/proxies/[id]/whitelist/route.ts. Any owner
// (self-created or reseller-allocated) can manage their own credential's
// whitelist via the API too, same as the dashboard — locking a credential to
// specific source IPs doesn't reverse anything a reseller paid for, unlike
// delete/topup.
//
// These routes now go through withApiAuth like every other v1 route: they used
// to call requireApiAccess directly, so responses carried no X-Request-Id, a
// malformed JSON body surfaced as '"" is not a valid IPv4 address', and the
// request-log / rate-limit headers were missing. Upstream failures are still
// mapped by whitelistErrorResponse (fixed customer-safe messages).

// GET /api/v1/sub-users/:id/whitelist
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET whitelist', async ({ user, supabase }) => {
    let upstreamId = ''
    try {
      const { id } = await context.params
      const cred = await getOwnedCredential(supabase, user.id, id, 'id, upstream_sub_user_id')
      if (!cred) return apiError(404, 'not_found', 'Sub-user not found')
      upstreamId = cred.upstream_sub_user_id ?? ''
      if (!cred.upstream_sub_user_id) return NextResponse.json({ ips: [], provisioning: true })
      return NextResponse.json({ ips: await listWhitelistedIps(cred.upstream_sub_user_id) })
    } catch (e) {
      return whitelistFailure(e, upstreamId)
    }
  })
}

// POST /api/v1/sub-users/:id/whitelist  { "ip": "203.0.113.7", "description": "Office" }
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST whitelist', async ({ user, supabase }) => {
    let upstreamId = ''
    try {
      const { id } = await context.params
      const json = await readJsonBody(req)
      if (!json.ok) return json.response
      const body = json.body
      const ip = typeof body?.ip === 'string' ? body.ip.trim() : ''
      const description = typeof body?.description === 'string' ? body.description.trim() : ''

      // Well-formed AND publicly routable (a private/loopback address can never match a real connection).
      const ipError = validateIpForAdd(ip)
      if (ipError) return apiError(400, 'invalid_request', ipError.slice(0, 300))
      const descError = validateDescription(description)
      if (descError) return apiError(400, 'invalid_request', descError)

      const cred = await getOwnedCredential(supabase, user.id, id, 'id, upstream_sub_user_id')
      if (!cred) return apiError(404, 'not_found', 'Sub-user not found')
      upstreamId = cred.upstream_sub_user_id ?? ''
      if (!cred.upstream_sub_user_id) return apiError(409, 'conflict', 'This sub-user is still being provisioned — try again shortly.')

      const ips = await addWhitelistedIp(cred.upstream_sub_user_id, ip, description)
      await mirrorWhitelist(supabase, id, user.id, ips)
      await notifyWhitelistChanged(user.id, id, 'added', 1, 'api')
      return NextResponse.json({ ips }, { status: 201 })
    } catch (e) {
      return whitelistFailure(e, upstreamId)
    }
  })
}

// DELETE /api/v1/sub-users/:id/whitelist?ip=203.0.113.7
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'DELETE whitelist', async ({ user, supabase }) => {
    let upstreamId = ''
    try {
      const { id } = await context.params
      const ip = (new URL(req.url).searchParams.get('ip') || '').trim()
      if (!isValidIp(ip)) return apiError(400, 'invalid_request', `"${ip.slice(0, 60)}" is not a valid IPv4 or IPv6 address.`)

      const cred = await getOwnedCredential(supabase, user.id, id, 'id, upstream_sub_user_id')
      if (!cred) return apiError(404, 'not_found', 'Sub-user not found')
      upstreamId = cred.upstream_sub_user_id ?? ''
      if (!cred.upstream_sub_user_id) return apiError(409, 'conflict', 'This sub-user is still being provisioned — try again shortly.')

      const ips = await removeWhitelistedIp(cred.upstream_sub_user_id, ip)
      await mirrorWhitelist(supabase, id, user.id, ips)
      await notifyWhitelistChanged(user.id, id, 'removed', 1, 'api')
      return NextResponse.json({ ips })
    } catch (e) {
      return whitelistFailure(e, upstreamId)
    }
  })
}
