import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canonicalEmail, targetBuckets, TARGET_PER_ADDRESS_MAX, TARGET_PER_ADDRESS_WINDOW_S, TARGET_GLOBAL_MAX, TARGET_GLOBAL_WINDOW_S } from '../lib/targetThrottle.ts'
import { classifySession, sessionKeyFromUrl, REFRESH_MARGIN_S, stripSessionCookies } from '../lib/sessionProbe.ts'
import { edgeRequestId, guardResponse } from '../lib/edgeGuard.ts'
import { SECURITY_HEADERS, applySecurityHeaders } from '../lib/securityHeaders.ts'
import { cspHeaderName, cspEnforced } from '../lib/csp.ts'
import { cookiesAreBenign, cacheAge } from '../lib/edgeCache.ts'
import { PROTECTED_PREFIXES, isProtectedPath, unprotectedSource } from '../lib/protectedPaths.ts'
import { normalizeClientIp, clientKeyFromHeader, parseIpv6 } from '../lib/ipParse.ts'

// ── per-target email throttle ──────────────────────────────────────────────
test('one mailbox, one key: +tags, gmail dots and googlemail fold together', () => {
  assert.equal(canonicalEmail(' Victim+a@Gmail.com '), 'victim@gmail.com')
  assert.equal(canonicalEmail('v.i.c.t.i.m@googlemail.com'), 'victim@gmail.com')
  assert.equal(canonicalEmail('a.b@example.com'), 'a.b@example.com') // dots only ignored for gmail
  assert.equal(canonicalEmail('not-an-email'), 'not-an-email')
})

test('the target throttle cannot be used to lock the owner out from ONE address', () => {
  const buckets = targetBuckets('reset', 'victim@gmail.com', '203.0.113.9')
  assert.deepEqual(buckets.map((b) => b.kind), ['address', 'global'], 'address bucket is checked first')
  assert.ok(buckets[0].identifier.includes('203.0.113.9'), 'address bucket is keyed on the caller')
  assert.ok(!buckets[1].identifier.includes('203.0.113.9'), 'global bucket is not')

  // The most one address can ever push into the all-callers bucket (it is stopped by its own
  // bucket first, which returns early) must stay under that bucket's cap.
  const perAddressPerGlobalWindow = TARGET_PER_ADDRESS_MAX * Math.ceil(TARGET_GLOBAL_WINDOW_S / TARGET_PER_ADDRESS_WINDOW_S)
  assert.ok(perAddressPerGlobalWindow < TARGET_GLOBAL_MAX, `${perAddressPerGlobalWindow} must be < ${TARGET_GLOBAL_MAX}`)

  // Two callers get different address buckets for the same victim.
  const other = targetBuckets('reset', 'victim@gmail.com', '198.51.100.4')
  assert.notEqual(buckets[0].identifier, other[0].identifier)
  assert.equal(buckets[1].identifier, other[1].identifier)
})

test('without a client address only the all-callers bucket applies, and scopes stay separate per route', () => {
  assert.deepEqual(targetBuckets('signup', 'a@b.co', null).map((b) => b.kind), ['global'])
  const reset = targetBuckets('reset', 'a@b.co', '1.2.3.4')
  const resend = targetBuckets('resend', 'a@b.co', '1.2.3.4')
  assert.notEqual(reset[0].scope, resend[0].scope)
  assert.notEqual(reset[1].scope, resend[1].scope)
})

// ── client address grouping ────────────────────────────────────────────────
test('addresses group the way every per-address limit expects', () => {
  assert.equal(normalizeClientIp('203.0.113.9'), '203.0.113.9')
  assert.equal(normalizeClientIp('::ffff:203.0.113.9'), '203.0.113.9')
  const a = normalizeClientIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
  const b = normalizeClientIp('2001:db8:1:2:1111:2222:3333:4444')
  assert.equal(a, b, 'one /64 is one subscriber')
  assert.notEqual(a, normalizeClientIp('2001:db8:1:3::1'))
  assert.equal(clientKeyFromHeader(undefined), null)
  assert.equal(clientKeyFromHeader('  '), null)
  assert.equal(clientKeyFromHeader(' 198.51.100.4 '), '198.51.100.4')
  assert.equal(parseIpv6('not an address'), null)
})

// ── session probe ──────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0)
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url')
const session = (expiresInS, extra = {}) => JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', expires_at: Math.floor(NOW / 1000) + expiresInS, ...extra })
const cookie = (name, value) => `${name}=${value}`

test('a session whose access token is expired or about to expire is classified "refresh"', () => {
  const name = 'sb-abcdef-auth-token'
  assert.equal(classifySession(cookie(name, 'base64-' + b64url(session(3600))), NOW), 'fresh')
  assert.equal(classifySession(cookie(name, 'base64-' + b64url(session(-5))), NOW), 'refresh')
  assert.equal(classifySession(cookie(name, 'base64-' + b64url(session(REFRESH_MARGIN_S - 1))), NOW), 'refresh')
  assert.equal(classifySession(cookie(name, 'base64-' + b64url(session(REFRESH_MARGIN_S + 30))), NOW), 'fresh')
})

test('chunked, legacy-encoded and JWT-only sessions are read; junk is "unreadable"; other cookies are ignored', () => {
  const full = 'base64-' + b64url(session(-100))
  const mid = Math.floor(full.length / 2)
  const chunked = `${cookie('sb-abc-auth-token.1', full.slice(mid))}; ${cookie('sb-abc-auth-token.0', full.slice(0, mid))}`
  assert.equal(classifySession(chunked, NOW), 'refresh', 'chunks are joined in index order whatever order they arrive in')

  assert.equal(classifySession(cookie('sb-abc-auth-token', encodeURIComponent(session(-100))), NOW), 'refresh', 'plain URL-encoded JSON')

  // No `expires_at` key: auth-js drops it without a network call, and never reads the JWT's exp.
  const exp = Math.floor(NOW / 1000) - 10
  const jwt = `h.${b64url(JSON.stringify({ exp }))}.s`
  assert.equal(classifySession(cookie('sb-abc-auth-token', 'base64-' + b64url(JSON.stringify({ access_token: jwt, refresh_token: 'r' }))), NOW), 'unreadable', 'JWT-only session is dropped locally')

  assert.equal(classifySession(cookie('sb-abc-auth-token', 'base64-!!!not-base64'), NOW), 'unreadable')
  assert.equal(classifySession(cookie('sb-abc-auth-token', 'base64-%%%not-base64'), NOW), 'none', 'Next cannot decode the value and drops the cookie altogether')
  assert.equal(classifySession(cookie('sb-abc-auth-token', 'base64-' + b64url('{"no":"expiry"}')), NOW), 'unreadable')

  assert.equal(classifySession(null, NOW), 'none')
  assert.equal(classifySession('', NOW), 'none')
  assert.equal(classifySession('gp_ref=ABC; theme=dark', NOW), 'none')
  assert.equal(classifySession(cookie('sb-abc-auth-token-code-verifier', 'whatever'), NOW), 'none', 'the PKCE verifier is not a session')
})

// The probe must classify a cookie jar exactly as Next + @supabase/ssr + auth-js read it. Each
// case below was a way to make the server refresh against Supabase Auth while the probe said
// "fresh" or "unreadable" (verified against the real client, 2026-10 edge-pipeline audit).
test('session probe mirrors the real client: exact-vs-chunk precedence, gaps, duplicates, expires_at coercion', () => {
  const K = 'sb-abc-auth-token'
  const expired = 'base64-' + b64url(session(-100))
  const freshV = 'base64-' + b64url(session(3000))

  assert.equal(classifySession(`${K}=${expired}; ${K}.0=zzz`, NOW), 'refresh', 'exact cookie wins; a junk chunk beside it is ignored')
  assert.equal(classifySession(`${K}.0=zzz; ${K}=${expired}`, NOW), 'refresh', 'same, whatever the header order')
  assert.equal(classifySession(`${K}=${freshV}; ${K}.0=${expired}`, NOW), 'fresh', 'a fresh exact cookie is not made expired by a stale chunk')
  assert.equal(classifySession(`${K}.0=${expired}; ${K}.2=zzz`, NOW), 'refresh', 'chunks stop at the first gap; what follows is ignored')
  assert.equal(classifySession(`${K}.1=${expired}`, NOW), 'unreadable', 'without .0 there is no chunked value at all, so nothing to refresh')
  assert.equal(classifySession(`${K}=; ${K}.0=${expired}`, NOW), 'refresh', 'an EMPTY exact cookie falls through to the chunks')

  assert.equal(classifySession(`${K}=${freshV}; ${K}=${expired}`, NOW), 'refresh', 'the LAST duplicate wins (Next)')
  assert.equal(classifySession(`${K}=${expired}; ${K}=${freshV}`, NOW), 'fresh', 'the LAST duplicate wins (Next), not the first')
  assert.equal(classifySession(`${K}=${expired}; ${K}=%E0%A4%A`, NOW), 'refresh', 'a value Next cannot decode is skipped, the earlier one stays')

  const withExp = (expires_at) => `${K}=base64-` + b64url(JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', expires_at }))
  assert.equal(classifySession(withExp('1'), NOW), 'refresh', 'a string expires_at is coerced to a number, as auth-js does')
  assert.equal(classifySession(withExp(null), NOW), 'fresh', 'a falsy expires_at is "not expired" to auth-js')
  assert.equal(classifySession(withExp(0), NOW), 'fresh')
  const noKey = `${K}=base64-` + b64url(JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r' }))
  assert.equal(classifySession(noKey, NOW), 'unreadable', 'a session missing expires_at is not a session')
  assert.equal(classifySession(`${K}=base64-` + b64url('"just a string"'), NOW), 'unreadable')
})

test('with the project key known, other sb-*-auth-token cookies are ignored like the server ignores them', () => {
  assert.equal(sessionKeyFromUrl('https://abcdref.supabase.co'), 'sb-abcdref-auth-token')
  assert.equal(sessionKeyFromUrl('http://localhost:54321'), 'sb-localhost-auth-token')
  assert.equal(sessionKeyFromUrl(''), null)
  assert.equal(sessionKeyFromUrl(undefined), null)
  assert.equal(sessionKeyFromUrl('not a url'), null)
  const other = `sb-other-auth-token=base64-${b64url(session(-100))}`
  const mine = `sb-abcdref-auth-token=base64-${b64url(session(3000))}`
  assert.equal(classifySession(`${other}; ${mine}`, NOW), 'refresh', 'without the key, any expired one counts')
  assert.equal(classifySession(`${other}; ${mine}`, NOW, 'sb-abcdref-auth-token'), 'fresh')
  assert.equal(classifySession(other, NOW, 'sb-abcdref-auth-token'), 'none')
})

// ── edge cache decisions ───────────────────────────────────────────────────
test('only cookies that cannot personalise a public page keep a request cacheable', () => {
  assert.equal(cookiesAreBenign(undefined), true)
  assert.equal(cookiesAreBenign(''), true)
  assert.equal(cookiesAreBenign('gp_ref=ABC123; gp_sub=xyz'), true, 'referral cookies (60 days) must not bypass the cache')
  assert.equal(cookiesAreBenign('__cf_bm=1; _cfuvid=2'), true)
  assert.equal(cookiesAreBenign('sb-abc-auth-token=base64-xxx'), false)
  assert.equal(cookiesAreBenign('gp_ref=ABC; gp_mfa=tok'), false)
  assert.equal(cookiesAreBenign('some_future_cookie=1'), false, 'allow-list: unknown cookies stay out of the cache')
})

test('fresh / stale / expired copies', () => {
  const ttl = 300, stale = 600
  assert.equal(cacheAge(NOW - 10_000, NOW, ttl, stale), 'fresh')
  assert.equal(cacheAge(NOW - 301_000, NOW, ttl, stale), 'stale')
  assert.equal(cacheAge(NOW - 901_000, NOW, ttl, stale), 'expired')
  assert.equal(cacheAge(NOW - 301_000, NOW, ttl, 0), 'expired', 'no stale window (the status page)')
  assert.equal(cacheAge(null, NOW, ttl, stale), 'expired', 'unstamped copy is not trusted')
  assert.equal(cacheAge(NaN, NOW, ttl, stale), 'expired')
  assert.equal(cacheAge(NOW + 3_600_000, NOW, ttl, stale), 'expired', 'a stamp from the future is not trusted')
})

// ── protected paths ────────────────────────────────────────────────────────
test('protected areas match whole path segments only', () => {
  for (const p of ['/dashboard', '/dashboard/proxies', '/admin', '/admin/users/1', '/reseller', '/invoice/abc', '/invoice/abc/credit/1']) assert.equal(isProtectedPath(p), true, p)
  for (const p of ['/', '/administrator', '/dashboards', '/reseller-program', '/invoices', '/auth/login', '/blog/admin', '/api/admin/x']) assert.equal(isProtectedPath(p), false, p)
})

test('the static-CSP source (next.config.ts) is the exact complement of isProtectedPath', () => {
  const re = new RegExp(`^${unprotectedSource()}$`)
  const paths = ['/', '/privacy', '/administrator', '/dashboards', '/reseller-program', '/admin', '/admin/users', '/dashboard', '/dashboard/x', '/invoice/1', '/invoices', '/api/admin/x', '/blog/a']
  for (const p of paths) assert.equal(re.test(p), !isProtectedPath(p), p)
})

test('the middleware matcher still always runs on every protected prefix, whatever the extension', () => {
  const src = readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8')
  const m = src.match(/matcher:\s*\['([^']+)'\]/)
  assert.ok(m, 'matcher literal found')
  const re = new RegExp('^' + m[1].replace(/\\\\/g, '\\') + '$')
  for (const prefix of PROTECTED_PREFIXES) {
    assert.ok(m[1].includes(prefix.slice(1)), `${prefix} named in the matcher`)
    assert.equal(re.test(`${prefix}/abc.png`), true, `${prefix}/abc.png still goes through middleware`)
    assert.equal(re.test(prefix), true)
  }
  assert.equal(re.test('/logo.png'), false, 'ordinary static files skip it')
  assert.equal(re.test('/api/anything'), false)
  assert.equal(re.test('/blog/post'), true)
})

test('stripSessionCookies drops only the Supabase session cookies (and their chunks)', () => {
  assert.equal(stripSessionCookies(null), null)
  assert.equal(stripSessionCookies('sb-abc-auth-token=x'), null)
  assert.equal(stripSessionCookies('sb-abc-auth-token.0=x; sb-abc-auth-token.1=y'), null)
  assert.equal(stripSessionCookies('gp_ref=A; sb-abc-auth-token.0=x; theme=dark'), 'gp_ref=A; theme=dark')
  assert.equal(stripSessionCookies('sb-abc-auth-token-code-verifier=v; sb-abc-auth-token=x'), 'sb-abc-auth-token-code-verifier=v')
})

test('edgeRequestId honours a safe supplied id and mints otherwise', () => {
  assert.equal(edgeRequestId('abc-1.2:3'), 'abc-1.2:3')
  assert.match(edgeRequestId('has space'), /^req_[0-9a-f]{20}$/)
  assert.match(edgeRequestId('x'.repeat(65)), /^req_/)
  assert.match(edgeRequestId(null), /^req_/)
  assert.equal(guardResponse({ status: 413, error: 'x' }, 'req_1').headers.get('x-request-id'), 'req_1')
  assert.equal(guardResponse({ status: 413, error: 'x' }).headers.has('x-request-id'), false)
})

test('applySecurityHeaders sets every header, overwriting a weaker copy', () => {
  const h = new Headers({ 'x-frame-options': 'ALLOWALL' })
  applySecurityHeaders(h)
  for (const [k, v] of SECURITY_HEADERS) assert.equal(h.get(k), v)
  assert.equal(h.get('x-frame-options'), 'SAMEORIGIN')
  const mw = readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8')
  assert.match(mw, /applySecurityHeaders\(res\.headers\)/)
  const nc = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8')
  assert.match(nc, /SECURITY_HEADERS\.map/)
})

test('CSP_MODE_PROTECTED promotes the signed-in policy on its own; unset it follows CSP_MODE', () => {
  const save = { m: process.env.CSP_MODE, p: process.env.CSP_MODE_PROTECTED }
  try {
    delete process.env.CSP_MODE; delete process.env.CSP_MODE_PROTECTED
    assert.equal(cspHeaderName(), 'Content-Security-Policy-Report-Only')
    assert.equal(cspHeaderName(true), 'Content-Security-Policy-Report-Only')
    process.env.CSP_MODE_PROTECTED = 'enforce'
    assert.equal(cspHeaderName(true), 'Content-Security-Policy')
    assert.equal(cspHeaderName(), 'Content-Security-Policy-Report-Only', 'public pages stay report-only')
    process.env.CSP_MODE = 'enforce'; process.env.CSP_MODE_PROTECTED = 'report'
    assert.equal(cspEnforced(true), false)
    assert.equal(cspEnforced(), true)
    delete process.env.CSP_MODE_PROTECTED
    assert.equal(cspEnforced(true), true, 'unset = follows CSP_MODE')
  } finally {
    for (const [k, v] of [['CSP_MODE', save.m], ['CSP_MODE_PROTECTED', save.p]]) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})
