import test from 'node:test'
import assert from 'node:assert/strict'
import { findReportedError } from '../lib/cronReport.ts'

test('finds a top-level error', () => assert.equal(findReportedError({ error: 'boom' }), 'boom'))
test('finds an error nested in a sub-result', () => assert.equal(findReportedError({ retries: { error: 'x' }, ok: 1 }), 'x'))
test('ignores empty / non-string errors and clean results', () => {
  assert.equal(findReportedError({ error: '' }), null)
  assert.equal(findReportedError({ error: 5 }), null)
  assert.equal(findReportedError({ cleaned: 3, nested: { a: [1, 2] } }), null)
  assert.equal(findReportedError(null), null)
  assert.equal(findReportedError('error'), null)
})
test('does not recurse forever', () => {
  const deep = {}; let cur = deep
  for (let i = 0; i < 20; i++) { cur.n = {}; cur = cur.n }
  cur.error = 'too deep'
  assert.equal(findReportedError(deep), null)
})
test('the cleanup / security shapes surface their step errors', () => {
  assert.equal(findReportedError({ cleaned: 0, error: 'cleanup step(s) failed: MFA sessions' }), 'cleanup step(s) failed: MFA sessions')
  assert.equal(findReportedError({ notices_sent: 0, stock_watchdog: {}, error: 'audit-log retention failed: x' }), 'audit-log retention failed: x')
})
