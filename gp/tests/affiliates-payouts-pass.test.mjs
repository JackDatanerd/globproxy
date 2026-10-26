import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('reversing a paid payout clears the recorded M-Pesa shilling amount', () => {
  for (const f of ['supabase/migrations/0097_affiliates_payouts_pass.sql', 'supabase/schema.sql']) {
    const sql = read(f)
    const fn = sql.slice(sql.lastIndexOf('create or replace function public.admin_reverse_paid_payout'))
    assert.match(fn, /payout_local_currency = null, payout_local_amount = null, payout_fx_rate = null/)
  }
})

test('bulk allocation does not retry the daily new-recipient cap', () => {
  const route = read('app/api/reseller/allocate/route.ts')
  assert.match(route, /code: 'new_recipient_limit'/)
  const ui = read('components/reseller/ResellerUsersList.tsx')
  assert.match(ui, /res\.data\?\.code !== 'new_recipient_limit'/)
})

test('referrals page only says "awaiting the run" for money the run can take', () => {
  const page = read('app/dashboard/referrals/page.tsx')
  assert.match(page, /const runnable = payable - thisCycle/)
  assert.match(page, /runnable >= AFFILIATE_MIN_PAYOUT_USD/)
})
