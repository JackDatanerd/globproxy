import test from 'node:test'
import assert from 'node:assert/strict'
import { scrubSupplier, leaksSupplier } from '../lib/supplierGuard.ts'

// Built from pieces so this file does not trip scripts/check-supplier-leak.mjs.
const g = 'geo', n = 'node'

test('scrubSupplier removes every spelling of the supplier from text shown to customers or stored', () => {
  for (const v of [g + n, 'Geo' + 'Node', `${g}_${n}`, `${g}-${n}`, `${g} ${n}`.toUpperCase()]) {
    const out = scrubSupplier(`call to ${v} failed (user ${v}_42)`)
    assert.equal(leaksSupplier(out), false, out)
    assert.match(out, /upstream/)
  }
})

test('scrubSupplier leaves neutral text untouched', () => {
  assert.equal(scrubSupplier('ban failed: timeout'), 'ban failed: timeout')
  assert.equal(scrubSupplier(''), '')
})
