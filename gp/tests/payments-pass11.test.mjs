import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('a paid-but-not-creditable order is its own result, never reported as credited', () => {
  const b = read('lib/bandwidth.ts')
  assert.match(b, /status: 'not_creditable'; reason: 'account_deleted' \| 'dispute_lost'/)
  assert.match(b, /return \{ status: 'not_creditable', reason: 'account_deleted' \}/)
  const v = read('app/api/verify-payment/route.ts')
  const i = v.indexOf("result.status === 'not_creditable'")
  assert.ok(i > 0 && v.indexOf('success: true', i) > i)
  assert.match(v.slice(i, i + 400), /status: 409/)
  // one-click and auto-recharge only count a real credit as credited
  assert.match(read('lib/savedCardPay.ts'), /result\.status === 'credited' \|\| result\.status === 'already_credited'/)
  assert.match(read('lib/autoRecharge.ts'), /result\.status === 'credited' \|\| result\.status === 'already_credited'/)
  assert.match(read('app/api/webhooks/paystack/route.ts'), /result\.status === 'not_creditable'\) return NextResponse/)
  assert.match(read('app/api/admin/verify-order/route.ts'), /result\.status === 'not_creditable'/)
})

test('an accepted chargeback is applied even when the order was never credited', () => {
  const w = read('app/api/webhooks/paystack/route.ts')
  assert.match(w, /if \(accepted\) \{/)
  assert.doesNotMatch(w, /accepted && cur\.bandwidth_credited/)
})
