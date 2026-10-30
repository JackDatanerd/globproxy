import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isIsoDate } from '../lib/isoDate.ts'
import { anyLeaksSupplier } from '../lib/supplierGuard.ts'

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('impossible calendar dates are rejected, real ones kept', () => {
  assert.equal(isIsoDate('2026-02-31'), false)
  assert.equal(isIsoDate('2026-04-31'), false)
  assert.equal(isIsoDate('2026-02-28'), true)
})

test('every scheduled task except canary can be run from the panel', () => {
  const cron = read('app/api/cron/[task]/route.ts')
  const tasks = [...cron.matchAll(/case '([a-z]+)':/g)].map(m => m[1]).filter(t => t !== 'canary')
  const runnable = read('app/api/admin/cron-run/route.ts')
  for (const t of tasks) assert.ok(runnable.includes(`'${t}'`), `${t} missing from RUNNABLE`)
})

test('supplier name is caught in admin-typed customer text', () => {
  assert.equal(anyLeaksSupplier('ok', 'Geo Node is down'), true)
  assert.equal(anyLeaksSupplier('the provider is down', null), false)
})

test('admin-to-customer routes apply the supplier guard', () => {
  for (const r of ['inbox/reply', 'support-report', 'reject-affiliate', 'reject-reseller', 'reject-api-access', 'reverse-payout', 'void-payout', 'refund-request', 'suspend-user', 'ban-email']) {
    assert.ok(read(`app/api/admin/${r}/route.ts`).includes('anyLeaksSupplier'), r)
  }
})
