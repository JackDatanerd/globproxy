import { withApiAuth, readJsonBody } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { bulkAddWhitelistedIps, bulkRemoveWhitelistedIps } from '@/lib/geonode'
import { isValidIp, validateIpForAdd, validateDescription, notifyWhitelistChanged, MAX_BULK_ITEMS } from '@/lib/ipWhitelist'
import { getOwnedCredential } from '@/lib/credentials'
import { mirrorWhitelist, whitelistFailure } from '@/lib/whitelistMirror'
import { NextResponse } from 'next/server'

// Mirrors app/api/dashboard/proxies/[id]/whitelist/bulk/route.ts. Same
// withApiAuth treatment as the single-IP route (request ids, JSON errors).

// POST /api/v1/sub-users/:id/whitelist/bulk  { "items": [{ "ip", "description" }, …] }
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST whitelist bulk', async ({ user, supabase }) => {
    let upstreamId = ''
    try {
      const { id } = await context.params
      const json = await readJsonBody(req)
      if (!json.ok) return json.response
      const rawItems = Array.isArray(json.body?.items) ? json.body.items : null
      if (!rawItems || rawItems.length === 0) return apiError(400, 'invalid_request', 'items must be a non-empty array of { ip, description }.')
      if (rawItems.length > MAX_BULK_ITEMS) return apiError(400, 'invalid_request', `Max ${MAX_BULK_ITEMS} IPs per bulk request.`)

      const items: { ip: string; description: string }[] = []
      for (const raw of rawItems) {
        const ip = typeof raw?.ip === 'string' ? raw.ip.trim() : ''
        const description = typeof raw?.description === 'string' ? raw.description.trim() : ''
        const ipError = validateIpForAdd(ip)
        if (ipError) return apiError(400, 'invalid_request', `${(ip || '(empty)').slice(0, 60)}: ${ipError}`)
        const descError = validateDescription(description)
        if (descError) return apiError(400, 'invalid_request', `${ip}: ${descError}`)
        items.push({ ip, description })
      }

      const cred = await getOwnedCredential(supabase, user.id, id, 'id, upstream_sub_user_id')
      if (!cred) return apiError(404, 'not_found', 'Sub-user not found')
      upstreamId = cred.upstream_sub_user_id ?? ''
      if (!cred.upstream_sub_user_id) return apiError(409, 'conflict', 'This sub-user is still being provisioned — try again shortly.')

      const added = await bulkAddWhitelistedIps(cred.upstream_sub_user_id, items)
      await mirrorWhitelist(supabase, id, user.id, added)
      await notifyWhitelistChanged(user.id, id, 'added', items.length, 'api')
      return NextResponse.json({ ips: added }, { status: 201 })
    } catch (e) {
      return whitelistFailure(e, upstreamId)
    }
  })
}

// DELETE /api/v1/sub-users/:id/whitelist/bulk  { "ips": ["203.0.113.7", …] }
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'DELETE whitelist bulk', async ({ user, supabase }) => {
    let upstreamId = ''
    try {
      const { id } = await context.params
      const json = await readJsonBody(req)
      if (!json.ok) return json.response
      const rawIps = Array.isArray(json.body?.ips) ? json.body.ips : null
      if (!rawIps || rawIps.length === 0) return apiError(400, 'invalid_request', 'ips must be a non-empty array.')
      if (rawIps.length > MAX_BULK_ITEMS) return apiError(400, 'invalid_request', `Max ${MAX_BULK_ITEMS} IPs per bulk request.`)

      const ips: string[] = []
      for (const raw of rawIps) {
        const ip = typeof raw === 'string' ? raw.trim() : ''
        if (!isValidIp(ip)) return apiError(400, 'invalid_request', `"${(ip || '(empty)').slice(0, 60)}" is not a valid IPv4 or IPv6 address.`)
        ips.push(ip)
      }

      const cred = await getOwnedCredential(supabase, user.id, id, 'id, upstream_sub_user_id')
      if (!cred) return apiError(404, 'not_found', 'Sub-user not found')
      upstreamId = cred.upstream_sub_user_id ?? ''
      if (!cred.upstream_sub_user_id) return apiError(409, 'conflict', 'This sub-user is still being provisioned — try again shortly.')

      const left = await bulkRemoveWhitelistedIps(cred.upstream_sub_user_id, ips)
      await mirrorWhitelist(supabase, id, user.id, left)
      await notifyWhitelistChanged(user.id, id, 'removed', ips.length, 'api')
      return NextResponse.json({ ips: left })
    } catch (e) {
      return whitelistFailure(e, upstreamId)
    }
  })
}
