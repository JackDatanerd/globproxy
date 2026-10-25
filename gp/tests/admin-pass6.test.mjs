import test from 'node:test'
import assert from 'node:assert/strict'
import { paymentHoldMessage, PAYMENT_HOLD_MESSAGE, PAYMENT_HOLD_ADMIN_MESSAGE, placePaymentHold } from '../lib/paymentHold.ts'
import { verifiedOperatorReviewDue, VERIFIED_OPERATOR_REVIEW_DAYS } from '../lib/rates.ts'

test('an admin-placed hold never tells the customer a dispute was lost', () => {
  assert.equal(paymentHoldMessage('dispute_lost'), PAYMENT_HOLD_MESSAGE)
  assert.equal(paymentHoldMessage('admin'), PAYMENT_HOLD_ADMIN_MESSAGE)
  assert.ok(!/dispute/i.test(PAYMENT_HOLD_ADMIN_MESSAGE))
  assert.equal(paymentHoldMessage(null), PAYMENT_HOLD_MESSAGE)
})

// A fake client: the upsert resolves { data, error } like supabase-js does.
const fake = (result) => ({ from: () => ({ upsert: () => ({ select: async () => result }) }) })

test('placing a hold tells "placed", "already held" and "write failed" apart', async () => {
  const args = { reason: 'abuse', source: 'admin' }
  assert.equal(await placePaymentHold(fake({ data: [{ user_id: 'u' }], error: null }), 'u', args), true)
  assert.equal(await placePaymentHold(fake({ data: [], error: null }), 'u', args), false)
  const orig = console.error; console.error = () => {}
  try { await assert.rejects(placePaymentHold(fake({ data: null, error: { message: 'fk violation' } }), 'u', args), /fk violation/) }
  finally { console.error = orig }
})

test('a Verified Operator is due 180 days after the later of the grant and the last review', () => {
  const day = 86_400_000
  const since = '2026-01-01T00:00:00Z', review = '2026-03-01T00:00:00Z'
  assert.equal(verifiedOperatorReviewDue(since, null).getTime(), Date.parse(since) + VERIFIED_OPERATOR_REVIEW_DAYS * day)
  assert.equal(verifiedOperatorReviewDue(since, review).getTime(), Date.parse(review) + VERIFIED_OPERATOR_REVIEW_DAYS * day)
})

test('an operator with no recorded grant date and no review is due immediately, not exempt', () => {
  const d = verifiedOperatorReviewDue(null, null)
  assert.ok(d && d.getTime() < Date.now())
  assert.ok(verifiedOperatorReviewDue(undefined, undefined).getTime() < Date.now())
})
