import { GeonodeApiError } from '@/lib/geonode'
import { NextResponse } from 'next/server'

// Validates the IP formats Geonode's Whitelisted IPs endpoints accept —
// individual IPv4 or IPv6 addresses only, no CIDR ranges (confirmed
// against the live OpenAPI spec: the schema is `format: "ip"`, not
// "cidr"/"ipv4net"/"ipv6net"). Validated here before ever reaching
// Geonode, since their error for a malformed IP is just a generic 400
// with no field-level detail to relay back to the user — this lets the
// UI point at the actual bad value instead.

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

// Deliberately permissive full-form/compressed IPv6 matcher (not a strict
// RFC 4291 parser) — good enough to catch obvious garbage, CIDR suffixes,
// and non-IP strings; Geonode's own API remains the final authority on
// validity.
const IPV6_RE =
  /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^([0-9a-fA-F]{1,4}:){1,7}:$|^([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}$|^([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}$|^([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}$|^([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})$|^:((:[0-9a-fA-F]{1,4}){1,7}|:)$/

// IPv4-mapped IPv6 (::ffff:1.2.3.4) — what dual-stack stacks report for a v4
// client. The base matcher above rejected it.
const IPV4_MAPPED_RE = new RegExp('^::ffff:' + IPV4_RE.source.slice(1), 'i')

export function isValidIp(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  return IPV4_RE.test(v) || IPV6_RE.test(v) || IPV4_MAPPED_RE.test(v)
}

// Mirrors the spec's `description` schema (minLength 1, maxLength 100) —
// required on every write, not optional client-side sugar.
export function validateDescription(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'A description is required (e.g. "Office IP").'
  }
  if (value.trim().length > 100) {
    return 'Description must be 100 characters or fewer.'
  }
  return null
}

export const MAX_BULK_ITEMS = 150

// Central place both whitelist routes funnel a thrown GeonodeApiError (or
// anything else) through, so status handling doesn't drift between the
// single-IP route and the bulk route.
export function whitelistErrorResponse(e: unknown): NextResponse {
  if (e instanceof GeonodeApiError) {
    // A 401/403 here means OUR reseller API key was rejected by Geonode,
    // not anything the end user did — surfacing Geonode's raw status as
    // the user's own response would read as "your session/permissions are
    // wrong," which is false. Collapse both to a generic upstream error
    // and log the real cause for us to look at.
    if (e.status === 401 || e.status === 403) {
      console.error('Geonode rejected reseller API credentials on whitelist call:', e.status, e.body)
      return NextResponse.json({ error: 'IP whitelist service is temporarily unavailable. Please try again shortly.', code: 'upstream_unavailable' }, { status: 502 })
    }
    if (e.status === 404) {
      console.error('Whitelist upstream 404:', e.body)
      return NextResponse.json({ error: 'That whitelist entry could not be found.', code: 'not_found' }, { status: 404 })
    }
    if (e.status === 409) {
      console.error('Whitelist upstream 409:', e.body)
      return NextResponse.json({ error: 'That IP is already whitelisted, or the whitelist limit has been reached.', code: 'conflict' }, { status: 409 })
    }
    if (e.status === 400) {
      console.error('Whitelist upstream 400:', e.body)
      return NextResponse.json({ error: 'That request was rejected. Check the IP address and description and try again.', code: 'invalid_request' }, { status: 400 })
    }
    console.error('Unexpected Geonode whitelist error:', e.status, e.body)
    return NextResponse.json({ error: 'IP whitelist service is temporarily unavailable.', code: 'upstream_unavailable' }, { status: 502 })
  }
  console.error('Unexpected whitelist error:', e)
  return NextResponse.json({ error: 'Something went wrong. Please try again.', code: 'internal_error' }, { status: 500 })
}
