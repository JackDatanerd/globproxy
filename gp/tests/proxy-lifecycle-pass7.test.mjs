import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Source-level regression guards for the pass-7 lifecycle fixes (modules import through '@/').
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('a failed whitelist replay is remembered and retried by the cron', () => {
  assert.match(read('lib/credentials.ts'), /whitelist_replay_pending: true/)
  assert.match(read('lib/whitelistMirror.ts'), /export async function retryPendingWhitelistReplays/)
  assert.match(read('app/api/cron/[task]/route.ts'), /retryPendingWhitelistReplays\(/)
  assert.match(read('supabase/migrations/0094_proxy_lifecycle_pass7.sql'), /whitelist_replay_pending boolean not null default false/)
})

test('a replay only adds the entries the sub-user does not already have', () => {
  assert.match(read('lib/whitelistMirror.ts'), /!present\.has\(e\.ip\)/)
})

test('the "not responding" notice waits out the same grace as the admin alert', () => {
  assert.match(read('lib/credentials.ts'), /export const UPSTREAM_MISSING_GRACE_MS/)
  assert.match(read('app/dashboard/proxies/page.tsx'), /UPSTREAM_MISSING_GRACE_MS/)
  assert.match(read('lib/usageSync.ts'), /UPSTREAM_MISSING_GRACE_MS/)
})

test('"Retry now" claims only the clicked session', () => {
  assert.match(read('app/api/dashboard/proxies/[id]/retry/route.ts'), /credentialId: id/)
  assert.match(read('supabase/migrations/0094_proxy_lifecycle_pass7.sql'), /p_credential_id is null or c\.id = p_credential_id/)
})

test('a failed re-enable restores the original suspended reason, NULL included', () => {
  const s = read('lib/adminProxy.ts')
  assert.match(s, /suspended_reason: cred\.suspended_reason \?\? null/)
  assert.doesNotMatch(s, /suspended_reason \?\? 'admin'/)
})

test('no migration comment names the supplier any more', () => {
  assert.doesNotMatch(read('supabase/migrations/0094_proxy_lifecycle_pass7.sql'), /geo[\s_.\-]*node/i)
})
