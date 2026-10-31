import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summaryDaysDue, nextDay, SUMMARY_MAX_CATCHUP_DAYS } from '../lib/summaryDays.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

test('summaryDaysDue: nothing recorded sends just yesterday; already sent sends nothing', () => {
  assert.deepEqual(summaryDaysDue(null, '2026-10-28'), ['2026-10-28'])
  assert.deepEqual(summaryDaysDue('garbage', '2026-10-28'), ['2026-10-28'])
  assert.deepEqual(summaryDaysDue('2026-10-28', '2026-10-28'), [])
  assert.deepEqual(summaryDaysDue('2026-10-29', '2026-10-28'), [])
})

test('summaryDaysDue: a missed day is caught up, oldest first, across month ends', () => {
  assert.deepEqual(summaryDaysDue('2026-10-27', '2026-10-28'), ['2026-10-28'])
  assert.deepEqual(summaryDaysDue('2026-10-26', '2026-10-28'), ['2026-10-27', '2026-10-28'])
  assert.deepEqual(summaryDaysDue('2026-02-27', '2026-03-01'), ['2026-02-28', '2026-03-01'])
})

test('summaryDaysDue: a long outage is capped to the most recent days', () => {
  const days = summaryDaysDue('2026-01-01', '2026-10-28')
  assert.equal(days.length, SUMMARY_MAX_CATCHUP_DAYS)
  assert.equal(days[days.length - 1], '2026-10-28')
  assert.deepEqual(summaryDaysDue('2026-10-28', 'nonsense'), [])
})

test('nextDay rolls over month and year', () => {
  assert.equal(nextDay('2026-12-31'), '2027-01-01')
  assert.equal(nextDay('2026-02-28'), '2026-03-01')
})

test('resellers task reports its failed steps as `error` and re-arms a refused low-stock alert', () => {
  const src = read('lib/resellerCron.ts')
  assert.match(src, /problems\.push\(`invitation claim sweep failed/)
  assert.match(src, /problems\.push\(`invitation expiry failed/)
  assert.match(src, /problems\.push\(`low-stock query failed/)
  assert.match(src, /sendEmailSafe\(\{\s*to: r\.out_email/)
  assert.match(src, /reseller_low_stock_alerted_at: null/)
  // the machine-readable event goes out only after the e-mail was accepted
  assert.ok(src.indexOf("sendEmailSafe({\n        to: r.out_email") < src.indexOf("dispatchWebhook(r.out_reseller_id"))
})

test('deletion reminder claim requires the deletion to still be scheduled for the same moment', () => {
  const src = read('lib/accountDeletionCron.ts')
  const claim = src.slice(src.indexOf('deletion_reminder_sent_at: nowIso'), src.indexOf('deletion_reminder_sent_at: nowIso') + 400)
  assert.match(claim, /eq\('deletion_scheduled_at', p\.deletion_scheduled_at\)/)
  assert.match(claim, /or\('is_deleted\.is\.null,is_deleted\.eq\.false'\)/) // NULL counts as not deleted (pass 6)
})

test('ASN generator checks for a truncated export before writing any file', () => {
  const src = read('scripts/generate-asn-data.py')
  assert.ok(src.indexOf('REFUSING') < src.indexOf('write_text_atomic(os.path.join(OUT_DIR'))
  assert.ok(src.indexOf('REFUSING') < src.indexOf('os.makedirs(OUT_DIR'))
})
