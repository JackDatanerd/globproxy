import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Source-level regression guards for the pass-8 lifecycle fixes.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('retargeting to a new country clears the old ASN unless one is sent', () => {
  assert.match(read('lib/credentials.ts'), /asn: 'asn' in b \? b\.asn : \(countryChanged \? null : cred\.asn\)/)
})

test('the default auto top-up route validates with parseAutoTopup and is rate limited', () => {
  const src = read('app/api/dashboard/settings/auto-topup-default/route.ts')
  assert.match(src, /parseAutoTopup\(body\)/)
  assert.match(src, /rateLimitedUser\(/)
  assert.match(src, /P0002/)
  assert.doesNotMatch(src, /Boolean\(body\?\.enabled\)/)
  assert.match(read('supabase/migrations/0098_proxy_lifecycle_pass8.sql'), /p_threshold_gb > 100000 or p_amount_gb > 100000/)
})

test('the whitelist mirror is replaced in one transaction', () => {
  assert.match(read('lib/whitelistMirror.ts'), /rpc\('replace_whitelist_mirror'/)
  assert.match(read('supabase/migrations/0098_proxy_lifecycle_pass8.sql'), /function public\.replace_whitelist_mirror/)
})

test('a supplier listing without a documents array is incomplete, not empty', () => {
  assert.match(read('lib/upstream.ts'), /Array\.isArray\(result\?\.documents\)/)
})
