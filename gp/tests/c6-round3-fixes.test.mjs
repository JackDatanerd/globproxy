import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { register } from 'node:module'

// lib/ssrfGuard.ts imports './ipParse' without an extension (fine for the bundler and tsc, not for
// bare Node), so a tiny resolve hook retries a relative miss as '.ts' (same hook as api-integrations).
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx) } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && /^\\.{1,2}\\//.test(spec) && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx)
    throw e
  }
}`), import.meta.url)

const { isIsoTimestamp, isoToUtcString, applyCursor } = await import('../lib/cursor.ts')
const { validateWebhookUrl } = await import('../lib/ssrfGuard.ts')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

test('S1: re-sending the stored webhook URL does not reset the failure streak or re-run DNS', () => {
  const src = read('lib/webhookEndpoints.ts')
  assert.match(src, /let urlUnchanged = false/)
  assert.match(src, /cur\.url === url/)
  // the streak reset lives only in the changed-address branch
  const branch = src.slice(src.indexOf('} else {', src.indexOf('urlUnchanged = true')))
  assert.match(branch.slice(0, 700), /Object\.assign\(patch, FRESH_STREAK\)/)
  assert.equal((src.match(/Object\.assign\(patch, FRESH_STREAK\)/g) ?? []).length, 1)
  // a url-only no-op answers with the endpoint, not a 400
  assert.match(src, /if \(urlUnchanged\) return getEndpoint\(admin, userId, id\)/)
})

test('S2: webhook change notices are throttled per origin, not per event type', () => {
  const src = read('lib/integrationAudit.ts')
  assert.match(src, /MAX_NOTICES_PER_WINDOW = 5/)
  assert.match(src, /meta\?\.key_id \?\? null\) === \(p\.keyId \?\? null\)/)
  assert.match(src, /meta\?\.host \?\? null\) === \(p\.host \?\? null\)/)
  assert.match(src, /if \(throttled\) return/)
  assert.doesNotMatch(src, /if \(\(count \?\? 0\) > 0\) return/)
})

test('S3: date filters take real ISO 8601 only, and a missing offset means UTC', () => {
  for (const bad of ['1', '5', '2026', '0', '-1', 'Oct 5', '12/31/2026', '2026-02-30', '2026-13-01', '2026-10-23T25:00:00Z', 'yesterday'])
    assert.equal(isoToUtcString(bad), null, bad)
  assert.equal(isoToUtcString('2026-10-23'), '2026-10-23T00:00:00.000Z')
  assert.equal(isoToUtcString('2026-10-23T10:00'), '2026-10-23T10:00:00.000Z')
  assert.equal(isoToUtcString('2026-10-23 10:00:00'), '2026-10-23T10:00:00.000Z')
  assert.equal(isoToUtcString('2026-10-23T10:00:00Z'), '2026-10-23T10:00:00.000Z')
  assert.equal(isoToUtcString('2026-10-23T10:00:00+01:00'), '2026-10-23T09:00:00.000Z')
  assert.equal(isoToUtcString('2026-10-23T10:00:00+0100'), '2026-10-23T09:00:00.000Z')
  assert.equal(isoToUtcString('2026-10-23T10:00:00-05'), '2026-10-23T15:00:00.000Z')
  const src = read('lib/apiHelpers.ts')
  assert.match(src, /isoToUtcString\(raw\) \?\? undefined/)
  assert.doesNotMatch(src, /Date\.parse\(raw\)/)
})

test('S4: an impossible UTC offset is a 400 for a cursor, not a database error', () => {
  for (const bad of ['2026-10-23T10:00:00+25:00', '2026-10-23T10:00:00-15:00', '2026-10-23T10:00:00+14:30', '2026-10-23T10:00:00+05:75'])
    assert.equal(isIsoTimestamp(bad), false, bad)
  for (const ok of ['2026-10-23', '2026-10-23T10:00:00Z', '2026-10-23T10:00:00+14:00', '2026-10-23T10:00:00-12:00', '2026-10-23T10:00:00.123456+00:00', '2026-10-23T10:00:00+0530'])
    assert.equal(isIsoTimestamp(ok), true, ok)
  const q = { lt: () => q, or: () => q }
  assert.equal(applyCursor(q, '2026-10-23T10:00:00+25:00', null, 'int').ok, false)
})

test('S5: a literal * in the label search is not a wildcard-everything', () => {
  const src = read('lib/apiHelpers.ts')
  assert.match(src, /export const likeEscape = .*\.replace\(\/\\\*\/g, '_'\)/)
  const esc = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '_')
  assert.equal(esc('*'), '_')
  assert.equal(esc('a*b%c_d'), 'a_b\\%c\\_d')
  assert.ok(!esc('x*y').includes('*'))
})

test('S6: workers.dev is still refused, with an accurate message', () => {
  for (const u of ['https://x.workers.dev/', 'https://a.b.workers.dev/hook', 'https://workers.dev/', 'https://X.Workers.Dev./']) {
    const e = validateWebhookUrl(u)
    assert.match(e, /workers\.dev/, u)
    assert.doesNotMatch(e, /GlobProxy itself/, u)
  }
  assert.match(validateWebhookUrl('https://a.globproxy.com/'), /GlobProxy itself/)
  assert.equal(validateWebhookUrl('https://hooks.example-receiver.io/x'), null)
  assert.match(read('app/docs/api/page.tsx'), /workers\.dev/)
})
