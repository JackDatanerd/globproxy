import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Regression guards for the Section 4 (proxy lifecycle) bug pass.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('allocation drift detector: migration, reporter and cleanup wiring', () => {
  const sql = read('supabase/migrations/0113_proxy_lifecycle_section4_closeout.sql')
  assert.match(sql, /create or replace function public\.allocation_drift\(\)/)
  assert.match(sql, /grant execute on function public\.allocation_drift\(\) to service_role/)
  assert.match(sql, /reseller_transfers/)
  const lib = read('lib/allocationDrift.ts')
  assert.match(lib, /rpc\('allocation_drift'\)/)
  assert.match(lib, /before\.get\(d\.user_id\) === d\.drift_gb/) // only drift unchanged across two reads is reported
  assert.doesNotMatch(lib, /\.update\(|\.delete\(/)             // read-only
  assert.match(read('app/api/cron/[task]/route.ts'), /await reportAllocationDrift\(\)/)
})

test('top-up passes only fixed, neutral text for balance and reseller errors', () => {
  const src = read('lib/credentials.ts')
  assert.doesNotMatch(src, /fail\(402, 'insufficient_bandwidth', msg\)/)
  assert.doesNotMatch(src, /fail\(403, 'forbidden', msg\)\n    \/\/ Only our own/)
})

test('caps derived from a rounded GB figure carry the 1 MB headroom', () => {
  assert.match(read('lib/adminProxy.ts'), /Math\.ceil\(usedGb \* 1024\) \+ 1\)/)
  assert.match(read('lib/credentials.ts'), /suspendedCapMb\(liveUsedGb \* 1024\)/)
  assert.match(read('lib/credentials.ts'), /expectedLimitMb\(nowAllocated\)/)
})

test('capacity classifier: validation errors are not capacity, real shortages are', () => {
  const src = read('lib/upstream.ts')
  const m = src.match(/if \(e\.status === 402 \|\| (\/.+\/)\.test\(msg\)\)/)
  assert.ok(m, 'classifier regex not found')
  const re = eval(m[1])
  for (const ok of ['Insufficient balance', 'not enough traffic in stock', 'requested exceeds available balance', 'Out of stock']) assert.ok(re.test(ok.toLowerCase()), ok)
  for (const bad of ['username not available', 'password must exceed 8 characters', 'invalid trafficlimitmb value', 'field is not allocated']) assert.ok(!re.test(bad.toLowerCase()), bad)
})

test('whitelist mirror never writes a list it could not re-verify', () => {
  const src = read('lib/whitelistMirror.ts')
  assert.match(src, /marking the mirror stale for the backfill/)
  assert.doesNotMatch(src, /mirroring the list from the change/)
})

test('customers cannot delete GlobProxy-suspended sessions for a refund', () => {
  assert.match(read('lib/credentials.ts'), /suspended_reason === 'admin' \|\| cred\.suspended_reason === 'account'/)
})

test('live usage refresh compare-and-swap handles a NULL counter', () => {
  assert.match(read('lib/usageLive.ts'), /cas\.is\('gb_used', null\)/)
})

test('my-ip reports the address family and the whitelist page warns on IPv6', () => {
  assert.match(read('app/api/dashboard/my-ip/route.ts'), /NextResponse\.json\(\{ ip, family \}/)
  assert.match(read('components/dashboard/IpWhitelist.tsx'), /data\.family === 'ipv6'/)
})

test('dashboard alert-level clamp matches the server bounds', () => {
  assert.match(read('app/dashboard/proxies/page.tsx'), /w >= 50 && u <= 99 && w < u/)
})
