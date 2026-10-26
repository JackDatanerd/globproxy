// Regression guards for Auth & MFA pass 8. lib/mfa.ts needs the Workers runtime, so these
// pin the shape of the fixes in source / SQL rather than executing them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('lazy secret rewrite is compare-and-set on the secret that was verified', () => {
  const s = read('lib/mfa.ts')
  const at = s.indexOf(".update({ secret: await encryptSecret(plain, userId) })")
  assert.ok(at > 0, 'rewrite update present')
  assert.match(s.slice(at, at + 200), /\.eq\('user_id', userId\)\s*\.eq\('secret', factor\.secret\)/)
})

test('an accepted backup code never leaves the 5th-attempt lock in place', () => {
  const s = read('lib/mfa.ts')
  const at = s.indexOf("rpc('mfa_clear_failures'")
  assert.ok(at > 0)
  const block = s.slice(at - 60, at + 700)
  assert.match(block, /clearErr/)
  assert.match(block, /refundAttempt\(supabase, userId, gate\)/)
})

test('authenticator change counts as a payout-hold event, and email changes are policed in SQL', () => {
  const m = read('supabase/migrations/0090_auth_mfa_pass8.sql')
  assert.match(m, /'mfa_rekeyed'/)
  assert.match(m, /before update of email_change on auth\.users/)
  assert.match(m, /is_email_banned\(new\.email_change\)/)
})

test('mfa-setup sends an enrolled-but-unverified session to the code prompt', () => {
  const s = read('app/auth/mfa-setup/page.tsx')
  assert.match(s, /res\.status === 403 && data\?\.code === 'mfa_required'/)
  assert.match(s, /\/auth\/mfa-verify/)
})
