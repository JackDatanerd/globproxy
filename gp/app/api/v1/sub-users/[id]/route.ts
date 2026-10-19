import { withApiAuth, readJsonBody, failFrom } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseLabel, parseTargeting, parseSessionOptions } from '@/lib/apiValidation'
import { deleteCredential, getOwnedCredential, toApiCredential, CRED_COLS } from '@/lib/credentials'
import { getProxyPort } from '@/lib/proxyEndpoint'
import { NextResponse } from 'next/server'

// GET /api/v1/sub-users/:id
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET sub-user', async ({ user, supabase }) => {
    const { id } = await context.params
    const cred = await getOwnedCredential(supabase, user.id, id)
    if (!cred) return apiError(404, 'not_found', 'Sub-user not found')
    return NextResponse.json(toApiCredential(cred))
  })
}

// PATCH /api/v1/sub-users/:id — label and connection settings (targeting,
// protocol, session type, sticky duration). Bandwidth is changed with
// /topup; none of this touches the upstream sub-user (targeting lives in
// the connection username), so it takes effect immediately.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'PATCH sub-user', async ({ user, supabase }) => {
    const { id } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const body = json.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'invalid_request', 'Request body must be a JSON object.')

    const cred = await getOwnedCredential(supabase, user.id, id)
    if (!cred) return apiError(404, 'not_found', 'Sub-user not found')

    const patch: Record<string, unknown> = {}

    if ('label' in body) {
      const label = parseLabel(body.label)
      if (!label.ok) return apiError(400, 'invalid_request', label.error)
      patch.label = label.value
    }

    if (['country', 'state', 'city', 'asn'].some((k) => k in body)) {
      const merged = {
        country: 'country' in body ? body.country : cred.country,
        state: 'state' in body ? body.state : cred.state,
        city: 'city' in body ? body.city : cred.city,
        asn: 'asn' in body ? body.asn : cred.asn,
      }
      const t = parseTargeting(merged)
      if (!t.ok) return apiError(400, 'invalid_request', t.error)
      Object.assign(patch, t.value)
    }

    if (['session_type', 'protocol', 'sticky_duration'].some((k) => k in body)) {
      const s = parseSessionOptions(
        { session_type: body.session_type, protocol: body.protocol, sticky_duration: 'sticky_duration' in body ? body.sticky_duration : cred.sticky_duration },
        { session_type: cred.session_type, protocol: cred.protocol }
      )
      if (!s.ok) return apiError(400, 'invalid_request', s.error)
      Object.assign(patch, s.value)
      patch.port = getProxyPort(s.value.protocol, s.value.session_type)
    }

    if (Object.keys(patch).length === 0) {
      return apiError(400, 'invalid_request', 'No updatable fields provided. Supported: label, country, state, city, asn, session_type, protocol, sticky_duration.')
    }

    const { data, error } = await supabase
      .from('proxy_credentials').update(patch).eq('id', id).eq('user_id', user.id).select(CRED_COLS).maybeSingle()
    if (error) {
      console.error('[v1 PATCH sub-user] update failed', error)
      return apiError(500, 'internal_error', 'Could not update the sub-user.')
    }
    if (!data) return apiError(404, 'not_found', 'Sub-user not found')
    return NextResponse.json(toApiCredential(data))
  })
}

// DELETE /api/v1/sub-users/:id — see lib/credentials.ts deleteCredential for
// the ordering guarantees (upstream delete must succeed first; retry-safe).
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'DELETE sub-user', async ({ user, supabase }) => {
    const { id } = await context.params
    const result = await deleteCredential(supabase, user.id, id, 'api')
    if (!result.ok) return failFrom(result)
    return NextResponse.json({ success: true, gb_released: result.data.gb_released })
  })
}
