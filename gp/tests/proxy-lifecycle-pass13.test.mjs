import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const creds = read('lib/credentials.ts')

test('B1: activating a provisioned session never rewrites its port (an edit made while pending would be undone)', () => {
  const i = creds.indexOf("status: 'active',\n        upstream_sub_user_id: gcred.upstream_sub_user_id")
  assert.ok(i > 0)
  const block = creds.slice(i, creds.indexOf('.eq(\'id\', cred.id).eq(\'status\', \'pending\').select(\'id, gb_allocated\')', i))
  assert.doesNotMatch(block, /port:\s*gcred\.port/)
  assert.match(block, /host: gcred\.host/)
})

test('B2: the dashboard session PATCH cannot edit a terminated session', () => {
  const s = read('app/api/dashboard/sessions/[sessionId]/route.ts')
  const patch = s.slice(s.indexOf('export async function PATCH'), s.indexOf('export async function DELETE'))
  assert.match(patch, /\.is\('terminated_at', null\)/)
  assert.doesNotMatch(patch, /if \(body\.terminate === true\) q = q\.is/)
})

test('B3: retry route validates the id and answers a database error with 503, not 404', () => {
  const s = read('app/api/dashboard/proxies/[id]/retry/route.ts')
  assert.match(s, /isUuidString\(id\)/)
  assert.match(s, /ownedErr/)
  assert.match(s, /status: 503/)
})

test('R1: delete persists the frozen final usage before the supplier copy is destroyed', () => {
  const s = creds.slice(creds.indexOf('async function deleteCredentialLocked'))
  const persist = s.indexOf("update({ gb_used: liveUsedGb")
  const del = s.indexOf('await deleteSubUser(cred.upstream_sub_user_id)')
  assert.ok(persist > 0 && del > persist, 'usage must be saved before deleteSubUser')
  assert.match(s.slice(persist, del), /\.eq\('gb_used', before\)/)
  assert.match(s.slice(persist, del), /recordUsageDeltas/)
})

test('R2: release refuses an auto-allocate-triggering amount before touching the live cap', () => {
  const s = creds.slice(creds.indexOf('export async function releaseCredentialBandwidth'))
  const guard = s.indexOf('cred.auto_topup_enabled && (target - used) <=')
  const patch = s.indexOf('await updateSubUserTrafficLimit(cred.upstream_sub_user_id, expectedLimitMb(target))')
  assert.ok(guard > 0 && patch > guard)
  assert.match(s, /auto_topup_enabled, auto_topup_threshold_gb/)
})

test('R3: a delete holds a lock that the limit reconciler honours', () => {
  assert.match(creds, /deleteLockKey = \(id: string\) => internalLockKey\('delete', id\)/)
  const sync = creds.slice(creds.indexOf('export async function syncCredentialLimit'), creds.indexOf('export async function topupCredential'))
  assert.match(sync, /deleteInFlight\(admin, cred\.user_id as string, credentialId\)/)
  assert.ok(sync.indexOf('deleteInFlight') < sync.indexOf('updateSubUserTrafficLimit'))
  const del = creds.slice(creds.indexOf('export async function deleteCredential('), creds.indexOf('async function deleteCredentialLocked'))
  assert.match(del, /claimIdempotencyKey/)
  assert.match(del, /finally \{\s*if \(claimed\) await releaseIdempotencyKey/)
})

test('R4: dashboard top-ups (single and bulk) accept an Idempotency-Key and the UI sends a stable one', () => {
  const one = read('app/api/dashboard/proxies/[id]/topup/route.ts')
  assert.match(one, /allowStaleTakeover: false/)
  assert.match(one, /completeIdempotencyKey/)
  assert.match(one, /releaseIdempotencyKey/)
  const bulk = read('app/api/dashboard/proxies/bulk-action/route.ts')
  assert.match(bulk, /runItemOnce\(admin, userId, `\$\{key\}#\$\{id\}`, 'bulk-topup'/)
  assert.match(read('components/dashboard/ProxyCard.tsx'), /'Idempotency-Key': topupKeyRef\.current\.key/)
  assert.match(read('components/dashboard/ProxyList.tsx'), /bulkTopupKeys/)
  assert.match(read('lib/clientApi.ts'), /extraHeaders\?: Record<string, string>/)
})
