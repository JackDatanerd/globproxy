import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('a duplicate charge.dispute.create never re-stamps dispute_opened_at on an open dispute', () => {
  const w = read('app/api/webhooks/paystack/route.ts')
  // An already-open dispute is treated as handled for a create event (like 'resolved' is)…
  assert.match(w, /\(opened && \(cur\.dispute_status === 'resolved' \|\| cur\.dispute_status === 'open'\)\)/)
  // …so the only write that sets dispute_opened_at is reached from a not-yet-open order.
  assert.equal((w.match(/dispute_opened_at: new Date\(\)/g) ?? []).length, 1)
  // The customer e-mail guard stays (still once, on the transition).
  assert.match(w, /opened && cur\.dispute_status !== 'open' && !cur\.is_canary/)
})

test('stale automatic top-ups are closed with their own reason, not "Abandoned"', () => {
  const c = read('app/api/cron/[task]/route.ts')
  assert.match(c, /failure_reason: 'Abandoned — not paid within 24h'[\s\S]*?\.eq\('auto_recharge', false\)/)
  assert.match(c, /failure_reason: 'Automatic top-up was not confirmed within 24h'[\s\S]*?\.eq\('auto_recharge', true\)/)
})
