import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Source-level regression guards for the pass-10 lifecycle fixes.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('sessions route tolerates a null / array body and never echoes a raw constraint message', () => {
  const src = read('app/api/dashboard/proxies/[id]/sessions/route.ts')
  assert.match(src, /rawBody && typeof rawBody === 'object' && !Array\.isArray\(rawBody\)/)
  assert.match(src, /violates\|constraint/)
})

test('password rotation takes a per-session lock and releases it', () => {
  const src = read('lib/credentials.ts')
  assert.match(src, /internalLockKey\('rotate', id\)/)
  assert.match(src, /rotateCredentialPasswordLocked/)
  assert.match(src, /releaseIdempotencyKey\(admin, userId, lockKey\)/)
})

test('usage credit uses the gb_used the write replaced (migration 0100) with a snapshot fallback', () => {
  assert.match(read('lib/usageSync.ts'), /gb: Array\.isArray\(written\) \? 0 : c\.delta/)
  assert.match(read('lib/usageSync.ts'), /gb: c\.gb_used - prev/)
  assert.match(read('supabase/migrations/0100_proxy_lifecycle_pass10.sql'), /for update of pc/)
})

test('live usage refresh swaps on the value it read and stamps freshness on a lower reading', () => {
  const src = read('lib/usageLive.ts')
  assert.match(src, /\.eq\('gb_used', prevGb\)/)
  assert.match(src, /update\(\{ usage_synced_at: now \}\)/)
})

test('the upstream timeout also covers the response body', () => {
  assert.doesNotMatch(read('lib/upstream.ts').split('async function gfetchOnce')[1].split('async function gfetch(')[0], /finally\s*\{\s*clearTimeout/)
})

test('an account-level suspend only touches an active session', () => {
  assert.match(read('lib/adminProxy.ts'), /if \(reason === 'account'\) q = q\.eq\('status', 'active'\)/)
})

test('whitelist mirror writes are serialized and re-read upstream', () => {
  assert.match(read('lib/whitelistMirror.ts'), /internalLockKey\('whitelist-mirror', credentialId\)/)
  for (const f of ['app/api/dashboard/proxies/[id]/whitelist/route.ts', 'app/api/dashboard/proxies/[id]/whitelist/bulk/route.ts', 'app/api/v1/sub-users/[id]/whitelist/route.ts', 'app/api/v1/sub-users/[id]/whitelist/bulk/route.ts']) {
    assert.doesNotMatch(read(f), /mirrorWhitelist\([^)]*\b(ips|added|left|result)\)/)
  }
})
