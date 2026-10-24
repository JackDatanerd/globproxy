import test from 'node:test'
import assert from 'node:assert/strict'
import { leaksSupplier } from '../lib/supplierGuard.ts'
import { upstreamCostPerGbUsd } from '../lib/constants.ts'

test('the supplier guard catches the plausible spellings and passes neutral values', () => {
  // Built from pieces so this file itself does not trip scripts/check-supplier-leak.mjs.
  const g = 'geo', n = 'node'
  for (const v of [g + n, 'Geo' + 'Node', `${g}_${n}_user1`, `${g}-${n}`, `a.${g} ${n}.b`, `user-${g}${n}-1`.toUpperCase()]) assert.equal(leaksSupplier(v), true, v)
  for (const v of ['gp_abc123', 'proxy.globproxy.com', '', null, undefined, 42]) assert.equal(leaksSupplier(v), false, String(v))
})

test('the upstream cost comes only from the environment and is null when unusable', () => {
  const saved = process.env.UPSTREAM_COST_PER_GB_USD
  try {
    delete process.env.UPSTREAM_COST_PER_GB_USD
    assert.equal(upstreamCostPerGbUsd(), null)
    for (const bad of ['', '  ', 'abc', '0', '-1', 'NaN', 'Infinity']) { process.env.UPSTREAM_COST_PER_GB_USD = bad; assert.equal(upstreamCostPerGbUsd(), null, bad) }
    process.env.UPSTREAM_COST_PER_GB_USD = ' 0.5 '
    assert.equal(upstreamCostPerGbUsd(), 0.5)
  } finally { if (saved === undefined) delete process.env.UPSTREAM_COST_PER_GB_USD; else process.env.UPSTREAM_COST_PER_GB_USD = saved }
})
