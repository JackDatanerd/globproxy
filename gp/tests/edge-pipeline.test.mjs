import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canonicalEmail, targetBuckets, TARGET_PER_ADDRESS_MAX, TARGET_PER_ADDRESS_WINDOW_S, TARGET_GLOBAL_MAX, TARGET_GLOBAL_WINDOW_S } from '../lib/targetThrottle.ts'
import { classifySession, REFRESH_MARGIN_S } from '../lib/sessionProbe.ts'
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

  const exp = Math.floor(NOW / 1000) - 10
  const jwt = `h.${b64url(JSON.stringify({ exp }))}.s`
  assert.equal(classifySession(cookie('sb-abc-auth-token', 'base64-' + b64url(JSON.stringify({ access_token: jwt, refresh_token: 'r' }))), NOW), 'refresh', 'falls back to the access token exp')

  assert.equal(classifySession(cookie('sb-abc-auth-token', 'base64-%%%not-base64'), NOW), 'unreadable')
  assert.equal(classifySession(cookie('sb-abc-auth-token', 'base64-' + b64url('{"no":"expiry"}')), NOW), 'unreadable')

  assert.equal(classifySession(null, NOW), 'none')
  assert.equal(classifySession('', NOW), 'none')
  assert.equal(classifySession('gp_ref=ABC; theme=dark', NOW), 'none')
  assert.equal(classifySession(cookie('sb-abc-auth-token-code-verifier', 'whatever'), NOW), 'none', 'the PKCE verifier is not a session')
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
