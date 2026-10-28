import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('the buy page retries a failed /api/checkout/options instead of treating it as "M-Pesa off"', () => {
  const b = read('app/dashboard/buy/page.tsx')
  assert.match(b, /if \(!res\.ok\) continue/)
  assert.match(b, /attempt < 3/)
  const o = read('app/api/checkout/options/route.ts')
  // a lookup failure is a 503, not a 200 "unavailable"
  assert.match(o, /available: false \} \}, \{ status: 503/)
})

test('a late credit of an automatic top-up clears the failure streak without touching disabled_reason', () => {
  const s = read('lib/bandwidth.ts')
  const m = s.match(/select\('auto_recharge'\)[\s\S]*?\.gt\('consecutive_failures', 0\)/)
  assert.ok(m, 'streak reset present')
  assert.doesNotMatch(m[0], /disabled_reason/)
})

test('the automatic dispute path never overwrites an admin "won"', () => {
  const d = read('lib/disputes.ts')
  assert.match(d, /cur\?\.dispute_status === 'won'/)
  assert.match(d, /if \(opts\.keepWon\) lossWrite = lossWrite\.neq\('dispute_status', 'won'\)/)
  assert.match(read('app/api/webhooks/paystack/route.ts'), /amountUsd: partialUsd, keepWon: true/)
  // the admin's own 'lost' button stays a deliberate override
  assert.doesNotMatch(read('app/api/admin/dispute-outcome/route.ts'), /keepWon/)
})

test('an order whose dispute was lost is never credited afterwards', () => {
  const s = read('lib/bandwidth.ts')
  assert.match(s, /ord\?\.dispute_status === 'lost'[\s\S]*?return \{ status: 'already_credited' \}/)
  // checked before the atomic claim
  assert.ok(s.indexOf("dispute_status === 'lost'") < s.indexOf("rpc('claim_and_credit_order'"))
})
