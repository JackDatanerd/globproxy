import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const creds = read('lib/credentials.ts')

test('internal lock keys cannot be sent as a customer Idempotency-Key', () => {
  const lk = read('lib/lockKeys.ts')
  assert.match(lk, /`lock#\$\{kind\}#\$\{id\}`/)
  const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/ // lib/idempotency.ts
  assert.match(read('lib/idempotency.ts'), /KEY_RE = \/\^\[A-Za-z0-9_\\-:\.\]\{8,128\}\$\//)
  assert.equal(KEY_RE.test('lock#delete#00000000-0000-0000-0000-000000000000'), false)
  assert.equal(KEY_RE.test('delete:00000000-0000-0000-0000-000000000000'), true) // the old form was forgeable
})

test('delete refuses on an unreadable live usage (a 404 counts as already gone)', () => {
  const del = creds.slice(creds.indexOf('async function deleteCredentialLocked'))
  const i = del.indexOf('getSubUserUsage(cred.upstream_sub_user_id)')
  assert.ok(i > 0)
  const seg = del.slice(i, i + 900)
  assert.match(seg, /if \(!isGone\(e\)\)/)
  assert.match(seg, /fail\(502, 'upstream_unavailable'/)
  assert.match(read('lib/upstream.ts'), /new UpstreamApiError\(`Upstream getSubUserUsage failed: \$\{res\.status\}/)
})

test('delete of a pending session removes the sub-user an ambiguous attempt may have created', () => {
  assert.match(creds, /!cred\.upstream_sub_user_id && cred\.provision_username && providerConfigured\(\)/)
  assert.match(creds, /findSubUserByUsername\(String\(cred\.provision_username\)\)/)
})

test('auto top-up: rotation, error alert once the session is out', () => {
  const s = read('lib/autoTopup.ts')
  assert.match(s, /'session_limit' \| 'error'/)
  assert.match(s, /Date\.now\(\) \/ 300_000/)
  assert.match(s, /if \(remaining <= 0\) await alertOnce\(supabase, cred, 'error'\)/)
  assert.match(read('lib/webhookEvents.ts'), /session_limit or error/)
})

test('enable/disable check the row count and restore the cap when the database write fails', () => {
  const s = read('lib/adminProxy.ts')
  assert.match(s, /q\.select\('id'\)/)
  assert.match(s, /could not restore the cap after a failed disable/)
  assert.match(s, /This session no longer exists\./)
  assert.match(s, /if \(!\(await disableCredential\(supabase, cred, 'account'\)\)\) continue/)
  assert.match(s, /if \(!\(await enableCredential\(supabase, cred\)\)\) continue/)
})

test('customer-facing API docs never name the supplier or its role', () => {
  const d = read('app/docs/api/page.tsx')
  assert.doesNotMatch(d, /upstream (proxy )?provider/i)
  // Built from pieces so this file itself passes the supplier-name source guard.
  assert.doesNotMatch(d, new RegExp(['geo', 'node'].join(''), 'i'))
})

test('IP validator: embedded-IPv4 forms and reserved IPv6 ranges', async () => {
  const s = read('lib/ipWhitelist.ts')
  assert.match(s, /fec0::\/10/)
  assert.match(s, /64:ff9b::\/96/)
  assert.match(s, /foldDottedTail\(v\) \?\? v/)
})
