import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Source-level regression guards for the pass-5 lifecycle fixes (these modules import through the
// '@/' alias, which the bare node test runner can't resolve, so the invariants are asserted on the text).
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('a failed delete only restores the full cap for an ACTIVE session', () => {
  assert.match(read('lib/credentials.ts'), /if \(frozen && cred\.status === 'active'\)/)
})

test('create does not release a reservation once the credential row exists', () => {
  const s = read('lib/credentials.ts')
  assert.match(s, /let createdCred: any = null/)
  assert.match(s, /if \(createdCred\) return \{ ok: true/)
})

test('rotation is not committed on an unconfirmed password', () => {
  const s = read('lib/credentials.ts')
  assert.match(s, /confirmedByEcho = echoed === newPassword/)
  assert.match(s, /if \(!confirmedByEcho\)/)
})

test('a single pause refreshes ONE session, not the whole account', () => {
  const s = read('lib/credentialPause.ts')
  assert.doesNotMatch(s, /await syncUserUsage\(|import .*syncUserUsage/)
  assert.match(s, /refreshLiveUsage\(admin, userId, cred\)/)
})

test('post-credit retries keep the provisioning backoff; the first attempt does not', () => {
  const s = read('lib/bandwidth.ts')
  assert.match(s, /sendConfirmation: false, ignoreBackoff: false/)
  assert.match(s, /ignoreBackoff: opts\.ignoreBackoff \?\? true/)
})

test('the stalled-pending clock starts when a session last became pending', () => {
  assert.match(read('lib/credentials.ts'), /pending_since\.lt\./)
  const m = read('supabase/migrations/0087_proxy_lifecycle_pass5.sql')
  assert.match(m, /add column if not exists pending_since/)
  assert.match(m, /old\.status is distinct from 'pending'/)
})

test('the cron usage sync stamps usage_synced_at', () => {
  assert.match(read('lib/usageSync.ts'), /update\(\{ usage_synced_at: nowIso \}\)/)
})
