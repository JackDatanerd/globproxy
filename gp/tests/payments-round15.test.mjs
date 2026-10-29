import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('a payment received but never credited (deleted account) can be refunded from admin, in full, after Paystack confirms it', () => {
  const r = read('app/api/admin/refund-order/route.ts')
  assert.match(r, /bandwidth_credited/)
  assert.match(r, /uncreditedPayment/)
  assert.match(r, /\['pending', 'failed', 'cancelled'\]\.includes\(order\.payment_status\)/)
  assert.match(r, /verifyTransaction\(order\.paystack_reference\)/)
  assert.match(r, /txn\.status !== 'success'/)
  assert.match(r, /can only be refunded in full/)
  // A lost chargeback already took the money back.
  assert.match(r, /dispute_status === 'lost'/)
  const page = read('app/admin/orders/page.tsx')
  assert.match(page, /select\('id, email, full_name, is_deleted'\)/)
  assert.match(page, /!o\.bandwidth_credited && \['pending', 'failed', 'cancelled'\]\.includes\(o\.payment_status\) && \(!profile \|\| profile\.is_deleted\)/)
})

test('a chargeback never closes the customer\'s open refund request', () => {
  const mig = read('supabase/migrations/0111_payments_refund_request_dispute.sql')
  assert.match(mig, /create or replace function public\.apply_order_refund/)
  assert.match(mig, /if v_source = 'refund' then\s+update public\.refund_requests/)
  assert.match(mig, /grant execute on function public\.apply_order_refund\(uuid, text, numeric, numeric, text, text\) to service_role/)
  assert.match(mig, /next_credit_note_number\(\)/)
  assert.match(mig, /insert into public\.schema_migrations \(filename\) values\s+\('0111_payments_refund_request_dispute\.sql'\)/)
})

test('an auto-recharge decline found later by reconcile counts against the rule and uses the auto-recharge e-mail', () => {
  const f = read('lib/orderFailure.ts')
  assert.match(f, /if \(order\.auto_recharge\) \{\s+await recordAutoRechargeFailure/)
  // ...and it returns before the generic checkout "payment failed" e-mail.
  assert.ok(f.indexOf('recordAutoRechargeFailure(supabase') < f.indexOf('sendPaymentFailedEmail(supabase'))
  const a = read('lib/autoRecharge.ts')
  assert.match(a, /export async function recordAutoRechargeFailure/)
  assert.match(a, /failures >= RECHARGE_MAX_FAILURES/)
  // The synchronous path uses the same helper, so the two cannot drift.
  assert.match(a, /await recordAutoRechargeFailure\(supabase, userId, \{ amountUsd: quote\.total/)
  // Every caller that can flip an order passes auto_recharge.
  assert.match(read('app/api/cron/[task]/route.ts'), /created_at, auto_recharge'/)
  assert.match(read('app/api/webhooks/paystack/route.ts'), /paystack_reference, auto_recharge'\)/)
  assert.match(read('app/api/verify-payment/route.ts'), /created_at, auto_recharge'\)/)
})
