import test from 'node:test'
import assert from 'node:assert/strict'
import {
  needsCustomerAction, attemptStillOpen, ATTEMPT_OPEN_MS, orderSpend,
  cardValidUntil, cardExpired, cardExpiresSoon, cardExpiryLabel,
} from '../lib/rechargeRules.ts'
import { shapeOrder, shapeBilledTo } from '../lib/orderApi.ts'
import { orderTaxSummary } from '../lib/invoiceTax.ts'

const ctx = { siteUrl: 'https://globproxy.com', taxOf: orderTaxSummary }

test('a card that wants an OTP / 3-D Secure is a failure, a processing charge is not', () => {
  for (const s of ['send_otp', 'send_pin', 'send_phone', 'send_birthday', 'send_address', 'open_url', 'pay_offline']) assert.equal(needsCustomerAction(s), true, s)
  for (const s of ['success', 'failed', 'pending', 'processing', 'abandoned', '']) assert.equal(needsCustomerAction(s), false, s)
})

test('an earlier unsettled attempt blocks the next charge until it is old', () => {
  const now = Date.parse('2026-10-25T12:00:00Z')
  const at = (msAgo) => new Date(now - msAgo).toISOString()
  assert.equal(attemptStillOpen(null, now), false)
  assert.equal(attemptStillOpen({ payment_status: 'pending', bandwidth_credited: false, created_at: at(60_000) }, now), true)
  // a cancelled-but-unpaid order can still be settled by an in-flight charge
  assert.equal(attemptStillOpen({ payment_status: 'cancelled', bandwidth_credited: false, created_at: at(60_000) }, now), true)
  assert.equal(attemptStillOpen({ payment_status: 'pending', bandwidth_credited: false, created_at: at(ATTEMPT_OPEN_MS + 1000) }, now), false)
  assert.equal(attemptStillOpen({ payment_status: 'pending', bandwidth_credited: true, created_at: at(60_000) }, now), false)
  assert.equal(attemptStillOpen({ payment_status: 'failed', bandwidth_credited: false, created_at: at(60_000) }, now), false)
  assert.equal(attemptStillOpen({ payment_status: 'paid', bandwidth_credited: true, created_at: at(60_000) }, now), false)
  assert.equal(attemptStillOpen({ payment_status: 'pending', created_at: 'garbage' }, now), false)
})

test('the cap yardstick: pending in full, paid net of refunds, nothing else', () => {
  assert.equal(orderSpend([]), 0)
  assert.equal(orderSpend([
    { payment_status: 'pending', amount_usd: 20, refunded_usd: 0 },
    { payment_status: 'paid', amount_usd: 50, refunded_usd: 10 },
    { payment_status: 'paid', amount_usd: '30', refunded_usd: null },
    { payment_status: 'failed', amount_usd: 99 },
    { payment_status: 'refunded', amount_usd: 99, refunded_usd: 99 },
    { payment_status: 'paid', amount_usd: 5, refunded_usd: 9 }, // over-refunded never goes negative
  ]), 90)
})

test('card expiry runs to the end of the printed month', () => {
  assert.equal(cardValidUntil('12', '2030'), Date.UTC(2030, 12, 1))
  assert.equal(cardValidUntil('1', '27'), Date.UTC(2027, 1, 1))
  for (const [m, y] of [['', ''], ['13', '2030'], ['00', '2030'], ['12', '0'], ['ab', '2030'], [null, undefined]]) assert.equal(cardValidUntil(m, y), null, `${m}/${y}`)
  const now = Date.parse('2030-12-31T23:00:00Z')
  assert.equal(cardExpired('12', '2030', now), false) // still valid on the last day
  assert.equal(cardExpired('12', '2030', Date.parse('2031-01-01T00:00:00Z')), true)
  assert.equal(cardExpired('', '', now), false) // unknown expiry is never treated as expired
  assert.equal(cardExpiresSoon('12', '2030', Date.parse('2030-12-05T00:00:00Z')), true)
  assert.equal(cardExpiresSoon('12', '2030', Date.parse('2030-10-01T00:00:00Z')), false)
  assert.equal(cardExpiresSoon('12', '2030', Date.parse('2031-02-01T00:00:00Z')), false) // already expired is not "soon"
  assert.equal(cardExpiryLabel('3', '2029'), '03/2029')
  assert.equal(cardExpiryLabel('x', '2029'), null)
})

test('API order shape: invoice facts in, processor names out', () => {
  const row = {
    id: 'o1', gb_amount: '100', amount_usd: '249', payment_status: 'paid', plan_slug: 'growth', payment_method: 'paystack',
    pay_currency: null, pay_amount: null, tax_rate_pct: 16, tax_label: 'VAT', auto_recharge: true, dispute_status: null,
    invoice_number: 'INV-000123', refunded_usd: '10', refunded_at: '2026-10-02T00:00:00Z', created_at: 'c', paid_at: 'p',
  }
  const o = shapeOrder(row, ctx, [
    { order_id: 'o1', credit_note_number: 'CN-1', amount_usd: '10', created_at: 'r' },
    { order_id: 'other', credit_note_number: 'CN-9', amount_usd: '5', created_at: 'r' },
  ])
  assert.equal(o.payment_method, 'card') // never the processor's name
  assert.equal(o.charged_currency, 'USD')
  assert.equal(o.charged_amount, 249)
  assert.deepEqual(o.tax, { label: 'VAT', rate_pct: 16, included_usd: 34.34 })
  assert.equal(o.auto_recharge, true)
  assert.deepEqual(o.credit_notes, [{ number: 'CN-1', amount_usd: 10, created_at: 'r' }])
  assert.match(o.invoice_url, /\/invoice\/o1$/)
  assert.equal('billed_to' in o, false)
  assert.equal(JSON.stringify(o).toLowerCase().includes('paystack'), false)

  const mp = shapeOrder({ ...row, payment_method: 'mpesa', pay_currency: 'KES', pay_amount: 32250.5, tax_rate_pct: null, invoice_number: null }, ctx, [], null)
  assert.equal(mp.payment_method, 'mpesa')
  assert.equal(mp.charged_currency, 'KES')
  assert.equal(mp.charged_amount, 32250.5)
  assert.equal(mp.tax, null)
  assert.equal(mp.invoice_url, null)
  assert.equal(mp.billed_to, null)

  assert.deepEqual(shapeBilledTo({ name: 'Acme', tax_id: 'P051', junk: 1 }), { name: 'Acme', contact: null, email: null, address: null, tax_id: 'P051' })
  assert.equal(shapeBilledTo(null), null)
})
