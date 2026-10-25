import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { getOwnedCredential, CRED_COLS } from '@/lib/credentials'
import { buildProxyUsername, getProxyPort, deriveSessionId } from '@/lib/proxyEndpoint'
import { PROXY_HOST } from '@/lib/upstream'
import { isUuidString } from '@/lib/cursor'
import { leaksSupplier } from '@/lib/supplierGuard'
import { NextResponse } from 'next/server'

// GET /api/v1/sub-users/:id/endpoints?count=100&format=json|txt
// A ready-made proxy list, built exactly like the dashboard's "export": a STICKY
// sub-user yields `count` stable endpoints (each its own sticky session id, so each
// keeps its IP for the sub-user's sticky duration); a ROTATING one yields a single
// endpoint, because every connection to it already gets a fresh IP. `count`
// defaults to the sub-user's endpoint_count (max 1000). format=txt returns one
// host:port:username:password line per endpoint (text/plain).
const MAX_COUNT = 1000

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET sub-user endpoints', async ({ user, supabase }) => {
    const { id } = await context.params
    if (!isUuidString(id)) return apiError(404, 'not_found', 'Sub-user not found')
    const url = new URL(req.url)
    const format = url.searchParams.get('format') ?? 'json'
    if (format !== 'json' && format !== 'txt') return apiError(400, 'invalid_request', 'format must be json or txt.')

    const cred = await getOwnedCredential(supabase, user.id, id, CRED_COLS)
    if (!cred) return apiError(404, 'not_found', 'Sub-user not found')
    if (cred.status !== 'active' || !cred.upstream_username || !cred.upstream_password || leaksSupplier(cred.upstream_username)) {
      return apiError(409, 'conflict', 'This sub-user is not active yet (or is suspended), so it has no endpoints to list.')
    }

    const sticky = cred.session_type === 'sticky'
    const rawCount = url.searchParams.get('count')
    let count = rawCount === null || rawCount === '' ? Number(cred.endpoint_count) || 1 : Number(rawCount)
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      return apiError(400, 'invalid_request', `count must be a whole number from 1 to ${MAX_COUNT}.`)
    }
    if (!sticky) count = 1

    const host = cred.host && !leaksSupplier(cred.host) ? cred.host : PROXY_HOST
    const port = cred.port || getProxyPort(cred.protocol, cred.session_type)
    const scheme = cred.protocol === 'socks5' ? 'socks5' : 'http'
    const endpoints = Array.from({ length: count }, (_, i) => {
      const sessionId = sticky ? deriveSessionId(id, i) : null
      const username = sticky
        ? buildProxyUsername(cred.upstream_username, cred, sessionId!)
        : buildProxyUsername(cred.upstream_username, { ...cred, session_type: 'rotating', sticky_duration: null })
      return {
        host, port, username, password: cred.upstream_password as string, session_id: sessionId,
        url: `${scheme}://${encodeURIComponent(username)}:${encodeURIComponent(cred.upstream_password)}@${host}:${port}`,
      }
    })

    if (format === 'txt') {
      return new Response(endpoints.map((e) => `${e.host}:${e.port}:${e.username}:${e.password}`).join('\n') + '\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    return NextResponse.json({
      sub_user_id: id, protocol: cred.protocol ?? 'http', session_type: cred.session_type,
      rotating: !sticky, count: endpoints.length, endpoints,
    })
  })
}
