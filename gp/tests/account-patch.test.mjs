import test from 'node:test'
import assert from 'node:assert/strict'
import { anonymisedProfilePatch, rollbackProfilePatch } from '../lib/accountPatch.ts'

test('anonymising wipes identity but never touches suspension or the deletion bookkeeping', () => {
  const p = anonymisedProfilePatch()
  assert.equal(p.email, '[deleted]')
  assert.equal(p.full_name, '[deleted]')
  assert.equal(p.is_deleted, true)
  assert.ok(p.deleted_at)
  for (const k of ['is_suspended', 'suspended_at', 'suspension_reason', 'role']) assert.ok(!(k in p), `${k} must not be in the patch`)
  // The cool-off / cleanup columns are state of the deletion, not personal data.
  for (const k of Object.keys(p)) assert.ok(!k.startsWith('deletion_'), `${k} must not be cleared by the patch`)
})

test('rollback restores exactly the columns the patch cleared', () => {
  const before = { email: 'a@b.co', full_name: 'Ann', company_name: 'Co', api_access: true, mfa_enabled: true, is_verified_operator: true, payout_method: 'bank', is_deleted: false }
  const r = rollbackProfilePatch(before)
  assert.deepEqual(Object.keys(r).sort(), Object.keys(anonymisedProfilePatch()).sort())
  assert.equal(r.email, 'a@b.co')
  assert.equal(r.api_access, true)
  assert.equal(r.mfa_enabled, true)
  assert.equal(r.is_verified_operator, true)
  assert.equal(r.payout_method, 'bank')
  assert.equal(r.is_deleted, false)
  assert.equal(r.deleted_at, null)
})

test('rollback defaults booleans to false and the rest to null when the row had no value', () => {
  const r = rollbackProfilePatch({})
  assert.equal(r.api_access, false)
  assert.equal(r.mfa_enabled, false)
  assert.equal(r.is_verified_operator, false)
  assert.equal(r.company_name, null)
  assert.equal(r.is_deleted, false)
})
