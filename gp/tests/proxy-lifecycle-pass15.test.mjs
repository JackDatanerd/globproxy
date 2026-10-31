import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { leaksSupplier, scrubSupplier } from '../lib/supplierGuard.ts'

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const c = (...n) => String.fromCharCode(...n)
const a = c(103, 101, 111), b = c(110, 111, 100, 101)
const name = a + b

test('the supplier guard still catches every spelling after the name was removed from the source', () => {
  for (const v of [name, name.toUpperCase(), a + '-' + b, a + '_' + b, a + ' ' + b, `x.${name}.com`]) {
    assert.equal(leaksSupplier(v), true, v)
  }
  assert.equal(leaksSupplier('gp_abc123'), false)
  assert.ok(!leaksSupplier(scrubSupplier(`failed at ${name}`)))
  for (const f of ['lib/supplierGuard.ts', 'lib/upstream.ts', 'scripts/check-supplier-leak.mjs']) {
    assert.ok(!read(f).toLowerCase().includes(name), `${f} spells the supplier name out`)
  }
})

test('rotation retries a rolled-back verdict and reads the password back when the probe cannot answer', () => {
  const c = read('lib/credentials.ts')
  assert.match(c, /setTimeout\(r, 2000\)/)
  assert.match(c, /getSubUserPassword\(cred\.upstream_sub_user_id\)\) === newPassword/)
  assert.match(read('lib/upstream.ts'), /export async function getSubUserPassword/)
})

test('the limit reconciler also re-caps paused and held sessions, rechecking status first', () => {
  const u = read('lib/usageSync.ts')
  assert.match(u, /creds\.filter\(c => c\.status === 'suspended'\)/)
  assert.match(u, /paused: true/)
  assert.match(u, /fresh\?\.status !== 'suspended'/)
})

test('pausing records the live usage it read, and the sync stamp never overwrites a newer one', () => {
  assert.match(read('lib/adminProxy.ts'), /persistPausedUsage\(supabase, cred\.id, liveUsedGb\)/)
  assert.match(read('lib/usageSync.ts'), /usage_synced_at\.is\.null,usage_synced_at\.lt\.\$\{readAt\}/)
})
