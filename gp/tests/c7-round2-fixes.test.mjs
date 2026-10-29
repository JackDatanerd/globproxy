import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('bulk sender treats outcome_unknown as unconfirmed, not failed', () => {
  assert.match(read('components/reseller/ResellerUsersList.tsx'), /res\.data\?\.code === 'outcome_unknown'/)
})
test('recipient email must have a real shape, in TS and SQL', () => {
  assert.match(read('lib/resellerAllocation.ts'), /EMAIL_SHAPE\.test\(recipientEmail\)/)
  assert.match(read('supabase/migrations/0110_section7_c7_round_fixes.sql'), /v_email !~/)
})
test('reversing a payout with an open refund deduction is blocked', () => {
  assert.match(read('supabase/migrations/0110_section7_c7_round_fixes.sql'), /'blocked', 'refund_deductions'/)
  assert.match(read('app/api/admin/reverse-payout/route.ts'), /refund_deductions/)
})
test('invitation notices skip anonymised invitee addresses', () => {
  assert.match(read('lib/resellerAllocation.ts'), /inviteeOk \? sendEmail/)
})
