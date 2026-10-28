import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { register } from 'node:module'

// lib/ssrfGuard.ts imports './ipParse' without an extension (fine for the bundler and
// tsc, not for bare Node), so a tiny resolve hook retries a relative miss as '.ts'.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx) } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && /^\\.{1,2}\\//.test(spec) && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx)
    throw e
  }
}`), import.meta.url)

const {
  validateWebhookUrl, validateWebhookPort, isBlockedHostLiteral, isOwnHost,
  checkHostnameResolution, DNS_UNAVAILABLE_MESSAGE,
} = await import('../lib/ssrfGuard.ts')
const { ipAllowed, parseAllowedIps, allocateAllowlistProblem } = await import('../lib/ipAllowlist.ts')
const { WEBHOOK_EVENTS, WEBHOOK_WILDCARD, parseEventTypes, subscribesTo } = await import('../lib/webhookEvents.ts')
const { isUuidString } = await import('../lib/cursor.ts')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── SSRF guard ────────────────────────────────────────────────────────
test('webhook URLs: https only, no credentials, no private / loopback / own hosts', () => {
  assert.equal(validateWebhookUrl('https://hooks.example-receiver.io/x'), null)
  for (const bad of [
    'http://hooks.example-receiver.io/x', 'ftp://a.b.c/', 'not a url', 'https://user:pw@hooks.example-receiver.io/',
    'https://127.0.0.1/', 'https://[::1]/', 'https://10.0.0.5/', 'https://192.168.1.1/', 'https://169.254.169.254/latest',
    'https://localhost/', 'https://intranet/', 'https://box.internal/', 'https://[::ffff:127.0.0.1]/',
    'https://globproxy.com/api', 'https://x.workers.dev/', 'https://a.globproxy.com/',
  ]) assert.notEqual(validateWebhookUrl(bad), null, bad)
  assert.notEqual(validateWebhookUrl('https://a.b/' + 'x'.repeat(2100)), null)
})

test('only ports 443 and 8443 are accepted', () => {
  assert.equal(validateWebhookPort(new URL('https://a.example.io')), null)
  assert.equal(validateWebhookPort(new URL('https://a.example.io:443')), null)
  assert.equal(validateWebhookPort(new URL('https://a.example.io:8443')), null)
  for (const p of ['22', '25', '6379', '9200', '8080']) assert.notEqual(validateWebhookPort(new URL(`https://a.example.io:${p}`)), null, p)
})

test('host literal and own-host rules', () => {
  assert.equal(isBlockedHostLiteral('8.8.8.8'), false)
  assert.equal(isBlockedHostLiteral('example.com'), false)
  assert.equal(isBlockedHostLiteral('metadata'), true)
  assert.equal(isOwnHost('api.globproxy.com'), true)
  assert.equal(isOwnHost('notglobproxy.com'), false)
})

const resp = (body) => async () => ({ ok: true, json: async () => body })
test('DNS check: a name resolving to a private address is refused', async () => {
  const f = resp({ Status: 0, Answer: [{ type: 1, data: '10.1.2.3' }] })
  assert.match(await checkHostnameResolution('rebind-a.example.io', { fetchImpl: f }) ?? '', /private/)
})

test('DNS check: an unusable lookup fails open at delivery time but closed when a URL is saved', async () => {
  const down = async () => { throw new Error('resolver down') }
  assert.equal(await checkHostnameResolution('down-a.example.io', { fetchImpl: down }), null)
  assert.equal(await checkHostnameResolution('down-b.example.io', { fetchImpl: down, failClosed: true }), DNS_UNAVAILABLE_MESSAGE)
  const servfail = resp({ Status: 2 })
  assert.equal(await checkHostnameResolution('sf-a.example.io', { fetchImpl: servfail }), null)
  assert.equal(await checkHostnameResolution('sf-b.example.io', { fetchImpl: servfail, failClosed: true }), DNS_UNAVAILABLE_MESSAGE)
})

test('DNS check: a CNAME to our own domain and a missing name are refused', async () => {
  assert.match(await checkHostnameResolution('alias.example.io', { fetchImpl: resp({ Status: 0, Answer: [{ type: 5, data: 'x.globproxy.com.' }] }) }) ?? '', /GlobProxy/)
  assert.match(await checkHostnameResolution('nx.example.io', { requireResolvable: true, fetchImpl: resp({ Status: 3 }) }) ?? '', /does not resolve/)
})

// ── API key IP allowlist ──────────────────────────────────────────────
test('IP allowlist: empty allows anyone, otherwise exact / CIDR match, never an unknown client', () => {
  assert.equal(ipAllowed([], '1.2.3.4'), true)
  assert.equal(ipAllowed(null, null), true)
  assert.equal(ipAllowed(['203.0.113.7'], '203.0.113.7'), true)
  assert.equal(ipAllowed(['203.0.113.7'], '203.0.113.8'), false)
  assert.equal(ipAllowed(['203.0.113.0/24'], '203.0.113.200'), true)
  assert.equal(ipAllowed(['203.0.113.0/24'], '203.0.114.1'), false)
  assert.equal(ipAllowed(['2001:db8::/48'], '2001:db8:0:1::5'), true)
  assert.equal(ipAllowed(['2001:db8::/48'], '2001:db9::1'), false)
  assert.equal(ipAllowed(['203.0.113.7'], null), false)
  assert.equal(ipAllowed(['203.0.113.7'], 'garbage'), false)
  assert.equal(ipAllowed(['203.0.113.7'], '2001:db8::1'), false)
})

test('allocate keys must be pinned to a narrow range', () => {
  assert.notEqual(allocateAllowlistProblem([]), null)
  assert.notEqual(allocateAllowlistProblem(['10.0.0.0/8']), null)
  assert.equal(allocateAllowlistProblem(['203.0.113.0/24']), null)
  assert.equal(parseAllowedIps(['203.0.113.7']).ok, true)
  assert.equal(parseAllowedIps(['not-an-ip']).ok, false)
})

// ── Webhook event catalogue ───────────────────────────────────────────
test('the wildcard subscribes to everything, and unknown event names are rejected', () => {
  assert.equal(subscribesTo([WEBHOOK_WILDCARD], 'session_created'), true)
  assert.equal(subscribesTo(['session_low'], 'session_created'), false)
  assert.equal(subscribesTo(null, 'session_created'), false)
  assert.equal(parseEventTypes(['session_created', '*']).value?.[0], '*')
  assert.equal(parseEventTypes(['bandwith_exhausted']).ok, false)
  assert.equal(parseEventTypes([]).ok, false)
})

test('every subscribable event is allowed by the database CHECK constraint (and vice versa)', () => {
  const sql = readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8')
  const at = sql.lastIndexOf('add constraint webhook_endpoints_valid_events')
  assert.ok(at > 0, 'constraint not found in schema.sql')
  const block = sql.slice(at, sql.indexOf(']::text[]', at))
  const dbEvents = [...block.matchAll(/'([a-z_*]+)'/g)].map((m) => m[1]).filter((e) => e !== 'webhook_endpoints_valid_events')
  assert.deepEqual([...new Set(dbEvents)].sort(), [...WEBHOOK_EVENTS, WEBHOOK_WILDCARD].sort())
})

// ── Misc ──────────────────────────────────────────────────────────────
test('cursor ids must be real uuids', () => {
  assert.equal(isUuidString('5d0b2c1e-8a47-4f0e-9a41-0d7f6b1c2e33'), true)
  assert.equal(isUuidString("x'; drop table"), false)
  assert.equal(isUuidString(5), false)
})

test('the auto-disable rule in the database needs a 24h streak, and a re-enable clears it', () => {
  const mig = readFileSync(path.join(root, 'supabase', 'migrations', '0089_api_integrations_pass5.sql'), 'utf8')
  assert.match(mig, /failing_since <= now\(\) - interval '24 hours'|v_since <= now\(\) - interval '24 hours'/)
  const ep = readFileSync(path.join(root, 'lib', 'webhookEndpoints.ts'), 'utf8')
  assert.match(ep, /patch\.failing_since = null/)
})

// ── Pass 6 ────────────────────────────────────────────────────────────
const src = (p) => readFileSync(path.join(root, p), 'utf8')

test('pass 6: a database error is never reported as "not found"', () => {
  const cred = src('lib/credentials.ts')
  assert.match(cred, /if \(error\) throw new Error\(`getOwnedCredential failed/)
  assert.match(cred, /if \(!isUuidString\(id\)\) return null/)
  assert.match(cred, /getOwnedCredential\(admin, userId, id, 'label'\)\.catch\(\(\) => null\)/, 'a committed top-up must not become a 500')
  const ep = src('lib/webhookEndpoints.ts')
  assert.match(ep, /get failed/); assert.match(ep, /ownership check failed/); assert.match(ep, /rotate lookup failed/)
  const keys = src('lib/apiKeys.ts')
  assert.match(keys, /edit lookup failed/); assert.match(keys, /rotate lookup failed/)
  assert.match(keys, /return error \? null : data/, 'loadKeyOwner fails closed')
  const bulk = src('app/api/v1/sub-users/bulk-action/route.ts')
  assert.match(bulk, /status: 500, error: \{ code: 'internal_error'/, 'one item failing keeps the other results')
  const wh = src('lib/webhooks.ts')
  assert.match(wh, /endpoint lookup failed during retry/)
})

test('pass 6: webhook queue drains bursts but a dead endpoint cannot burn the tick', () => {
  const wh = src('lib/webhooks.ts')
  assert.match(wh, /const RETRIES_PER_RUN = 60/); assert.match(wh, /const PER_ENDPOINT_PER_RUN = 12/)
  assert.match(wh, /GROUP_STOP_AFTER_FAILURES = 2/)
  assert.match(wh, /if \(failStreak >= GROUP_STOP_AFTER_FAILURES\) break/)
})

test('pass 6: bulk pause does a whole-account sync only for large batches', () => {
  assert.match(src('app/api/v1/sub-users/bulk-action/route.ts'), /ids\.length > BULK_SYNC_MIN/)
  const d = src('app/api/dashboard/proxies/bulk-action/route.ts')
  assert.match(d, /action === 'pause' && ids\.length > 5/); assert.match(d, /\{ usageSynced \}/)
  // Dashboard UI pass: a failed up-front sync must not be reported to pauseCredential as fresh.
  assert.match(d, /usageSynced = await syncUserUsage\(user\.id\)\.then\(\(r\) => r\.usage_fetch_failures === 0 && r\.usage_write_ok && r\.recalc_ok,/)
})

test('dashboard UI pass: session PATCH/DELETE reject a malformed id with 404, not a 500', () => {
  const s = src('app/api/dashboard/sessions/[sessionId]/route.ts')
  assert.equal((s.match(/!isUuidString\(sessionId\)/g) ?? []).length, 2)
})

test('pass 6: idempotency stamps on sessions lapse with the 24h claim window', () => {
  assert.match(src('lib/idempotency.ts'), /export const IDEMPOTENCY_WINDOW_MS = 24 \* 3_600_000/)
  assert.match(src('lib/credentials.ts'), /age > IDEMPOTENCY_WINDOW_MS/)
  assert.match(src('lib/webhooks.ts'), /Date\.now\(\) - IDEMPOTENCY_WINDOW_MS/)
})

test('pass 6: webhook secret rotation is compare-and-set; grace inputs are strict; expired keys are not editable', () => {
  assert.match(src('lib/webhookEndpoints.ts'), /\.eq\('secret', current\.secret\)/)
  const keys = src('lib/apiKeys.ts')
  assert.match(keys, /export function graceInput/)
  assert.match(keys, /has expired and cannot be edited/)
  for (const f of ['app/api/dashboard/api-keys/[id]/rotate/route.ts', 'app/api/dashboard/webhooks/[id]/rotate-secret/route.ts', 'app/api/v1/webhooks/[id]/rotate-secret/route.ts']) {
    assert.match(src(f), /graceInput\(/, f)
    assert.doesNotMatch(src(f), /Number\(body\??\.grace_/, f)
  }
})
