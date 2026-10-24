import test from 'node:test'
import assert from 'node:assert/strict'
import { currentTax, taxIncluded, orderTax } from '../lib/invoiceTax.ts'
import { isBelowThreshold, withinCap, cooldownElapsed, validThreshold, validCap, RECHARGE_COOLDOWN_MS } from '../lib/rechargeRules.ts'

test('tax is off unless a sane rate is configured', () => {
  assert.equal(currentTax({}), null)
  assert.equal(currentTax({ INVOICE_TAX_RATE_PCT: '0' }), null)
  assert.equal(currentTax({ INVOICE_TAX_RATE_PCT: 'abc' }), null)
  assert.equal(currentTax({ INVOICE_TAX_RATE_PCT: '250' }), null)
  assert.deepEqual(currentTax({ INVOICE_TAX_RATE_PCT: '16' }), { rate: 16, label: 'VAT' })
  assert.deepEqual(currentTax({ INVOICE_TAX_RATE_PCT: '16', INVOICE_TAX_LABEL: '<b>GST</b>' }), { rate: 16, label: 'bGST/b' })
})
test('tax is the share contained in an inclusive price', () => {
  assert.equal(taxIncluded(116, 16), 16)
  assert.equal(taxIncluded(35, 16), 4.83)
  assert.equal(taxIncluded(0, 16), 0)
  assert.equal(taxIncluded(35, 0), 0)
})
test('an order without a rate has no tax line', () => {
  assert.equal(orderTax({}), null)
  assert.equal(orderTax({ tax_rate_pct: null }), null)
  assert.deepEqual(orderTax({ tax_rate_pct: '16', tax_label: null }), { rate: 16, label: 'VAT' })
})
test('recharge triggers strictly below the threshold', () => {
  assert.equal(isBelowThreshold(4.99, 5), true)
  assert.equal(isBelowThreshold(5, 5), false)
  assert.equal(isBelowThreshold(NaN, 5), false)
})
test('recharge respects the rolling cap', () => {
  assert.equal(withinCap(65, 35, 100), true)
  assert.equal(withinCap(66, 35, 100), false)
})
test('recharge cooldown', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  assert.equal(cooldownElapsed(null, now), true)
  assert.equal(cooldownElapsed(new Date(now - RECHARGE_COOLDOWN_MS + 1000).toISOString(), now), false)
  assert.equal(cooldownElapsed(new Date(now - RECHARGE_COOLDOWN_MS).toISOString(), now), true)
})
test('recharge settings validation', () => {
  assert.equal(validThreshold(5), true)
  assert.equal(validThreshold(0), false)
  assert.equal(validThreshold('5'), false)
  assert.equal(validCap(100), true)
  assert.equal(validCap(6000), false)
})
