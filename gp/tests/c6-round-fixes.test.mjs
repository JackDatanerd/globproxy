import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

test('W1: a new webhook URL or a rotated secret starts the failure streak over', () => {
  const src = read('lib/webhookEndpoints.ts')
  assert.match(src, /const FRESH_STREAK = \{ consecutive_failures: 0, failing_since: null, last_error: null \}/)
  const url = src.slice(src.indexOf('patch.url = url'), src.indexOf('patch.url = url') + 600)
  assert.match(url, /Object\.assign\(patch, FRESH_STREAK\)/)
  const rot = src.slice(src.indexOf('export async function rotateSecret'))
  assert.match(rot, /\.\.\.FRESH_STREAK/)
  // the streak reset must never switch the endpoint on or off by itself
  assert.doesNotMatch(src.slice(src.indexOf('const FRESH_STREAK'), src.indexOf('function generateSecret')), /enabled/)
})

test('W2: a failed manual re-send never downgrades a delivery the receiver already accepted', () => {
  const src = read('lib/webhooks.ts')
  assert.match(src, /const keepSucceeded = !!opts\.manual && !ok && d\.status === 'succeeded'/)
  assert.match(src, /if \(keepSucceeded\) \{\s*for \(const k of Object\.keys\(patch\)\) delete patch\[k\]/)
  assert.match(src, /attempt < 2 && !keepSucceeded/)
  // the endpoint-level bookkeeping (record_webhook_attempt) still runs for it
  assert.ok(src.indexOf("rpc('record_webhook_attempt'") > src.indexOf('keepSucceeded'))
})

test('W3: rotating an already-expired key with grace reports it as expired, not "keeps working until <past>"', () => {
  const src = read('lib/apiKeys.ts')
  assert.match(src, /if \(oldEnd <= Date\.now\(\)\) \{\s*return \{ ok: true, data: \{ \.\.\.created\.data, old_key_valid_until: null, old_key_expired: true/)
  assert.match(read('app/api/dashboard/api-keys/[id]/rotate/route.ts'), /old_key_expired \? 'The old key had already expired\.'/)
  assert.match(read('app/dashboard/api-keys/ApiKeysClient.tsx'), /data\.old_key_expired \? 'The old key had already expired\.'/)
})
