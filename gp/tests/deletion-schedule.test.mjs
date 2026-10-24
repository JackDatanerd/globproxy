import test from 'node:test'
import assert from 'node:assert/strict'
import { scheduledAtFor, isDeletionDue, isReminderDue, daysUntil, DELETION_COOL_OFF_DAYS } from '../lib/deletionSchedule.ts'

const now = new Date('2026-10-24T12:00:00Z')

test('schedules the cool-off ahead', () => {
  assert.equal(scheduledAtFor(now).toISOString(), '2026-10-31T12:00:00.000Z')
  assert.equal(DELETION_COOL_OFF_DAYS, 7)
})
test('due only once the time has come', () => {
  assert.equal(isDeletionDue(null, now), false)
  assert.equal(isDeletionDue('garbage', now), false)
  assert.equal(isDeletionDue('2026-10-24T12:00:01Z', now), false)
  assert.equal(isDeletionDue('2026-10-24T12:00:00Z', now), true)
  assert.equal(isDeletionDue('2026-10-20T00:00:00Z', now), true)
})
test('reminder: inside the last 24h, once, never for an already-due deletion', () => {
  assert.equal(isReminderDue('2026-10-25T11:00:00Z', null, now), true)
  assert.equal(isReminderDue('2026-10-25T13:00:00Z', null, now), false) // more than 24h away
  assert.equal(isReminderDue('2026-10-25T11:00:00Z', '2026-10-24T11:00:00Z', now), false) // already sent
  assert.equal(isReminderDue('2026-10-24T11:00:00Z', null, now), false) // already due
  assert.equal(isReminderDue(null, null, now), false)
})
test('days until rounds up and never goes negative', () => {
  assert.equal(daysUntil('2026-10-31T12:00:00Z', now), 7)
  assert.equal(daysUntil('2026-10-24T13:00:00Z', now), 1)
  assert.equal(daysUntil('2026-10-20T00:00:00Z', now), 0)
})
