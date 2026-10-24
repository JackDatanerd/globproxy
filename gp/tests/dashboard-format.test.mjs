import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDurationMinutes } from '../lib/format.ts'

test('formatDurationMinutes never prints a fractional hour', () => {
  assert.equal(formatDurationMinutes(1), '1 min')
  assert.equal(formatDurationMinutes(45), '45 min')
  assert.equal(formatDurationMinutes(60), '1 hr')
  assert.equal(formatDurationMinutes(100), '1 hr 40 min')
  assert.equal(formatDurationMinutes(1440), '24 hr')
  assert.equal(formatDurationMinutes(null), '—')
  assert.equal(formatDurationMinutes(NaN), '—')
})
