import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('credit-note numbers come from a transactional counter, not a sequence', () => {
  const mig = read('supabase/migrations/0096_payments_billing_pass7.sql')
  assert.match(mig, /create table if not exists public\.credit_note_counter/)
  assert.match(mig, /create or replace function public\.next_credit_note_number\(\)/)
  // The refund function takes its number from the counter and gives it back on a lost race.
  const fn = mig.slice(mig.indexOf('create or replace function public.apply_order_refund'))
  assert.doesNotMatch(fn, /nextval\(/)
  assert.match(fn, /public\.next_credit_note_number\(\)/)
  assert.match(fn, /set last_n = last_n - 1/)
  // Counter is service-role only.
  assert.match(mig, /revoke all on public\.credit_note_counter from public, anon, authenticated/)
  assert.match(mig, /grant execute on function public\.next_credit_note_number\(\) to service_role/)
})

test('every path that can credit an order stores the card the customer asked to save', () => {
  assert.match(read('app/api/webhooks/paystack/route.ts'), /captureSavedCardIfRequested\(supabase, order, metadata, data\)/)
  assert.match(read('app/api/verify-payment/route.ts'), /captureSavedCardIfRequested\(supabase, order, txn\.metadata, txn\)/)
  assert.match(read('app/api/cron/[task]/route.ts'), /captureSavedCardIfRequested\(supabase, o, txn\.metadata, txn\)/)
})

test('an automatic charge in flight cannot be cancelled or re-paid from Billing', () => {
  const page = read('app/dashboard/billing/page.tsx')
  assert.match(page, /o\.payment_status === 'pending' && !o\.auto_recharge/)
  assert.doesNotMatch(page, /\{o\.payment_status === 'pending' && \(\s*<button\s+onClick=\{\(\) => cancelOrder/)
})

test('a dispute resolution never overwrites an outcome decided meanwhile', () => {
  const w = read('app/api/webhooks/paystack/route.ts')
  assert.match(w, /upd\.is\('dispute_status', null\) : upd\.eq\('dispute_status', cur\.dispute_status\)/)
})
