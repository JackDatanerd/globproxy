import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const NAME = /geo[\s_.\-*]*node/i

test('no SQL file (migrations, baseline, schema) names the supplier, and the ratchet scans SQL', () => {
  const files = ['supabase/schema.sql', 'supabase/baseline/pre-0001-schema.sql',
    ...readdirSync(join(root, 'supabase/migrations')).map((f) => `supabase/migrations/${f}`)]
  for (const f of files) assert.ok(!NAME.test(read(f)), `${f} names the supplier`)
  assert.ok(!/\\\.sql\$\/i/.test(read('scripts/check-supplier-leak.mjs').split('const SKIP')[1].split('\n')[0]), 'the ratchet must not skip .sql')
})

test('a scheduled deletion is held while the account is suspended', () => {
  const eng = read('lib/accountDeletion.ts')
  assert.match(eng, /'suspended'/)
  assert.match(eng, /onlyIfDue\) claimQuery = claimQuery[^\n]*is_suspended\.is\.null,is_suspended\.eq\.false/)
  const cron = read('lib/accountDeletionCron.ts')
  assert.match(cron, /if \(before\.is_suspended\)/)
  assert.match(cron, /result\.stage === 'suspended'/)
  // and no "deleted tomorrow" reminder for a deletion that is on hold
  assert.match(cron, /deletion_reminder_sent_at', null\)\.or\('is_suspended\.is\.null,is_suspended\.eq\.false'\)/)
})

test('the purge clears the IPs and label an API-key row keeps after revocation, and 0115 back-fills', () => {
  assert.match(read('lib/accountDeletion.ts'), /last_used_ip: null, allowed_ips: \[\], label: 'Revoked'/)
  const m = read('supabase/migrations/0115_cron_deletion_ops_pass6.sql')
  assert.match(m, /update public\.api_keys/)
  assert.match(m, /is_deleted/)
})

test('the daily bandwidth alert stamps accounts it cannot mail instead of re-reading them every run', () => {
  const src = read('app/api/cron/[task]/route.ts')
  assert.match(src, /stampSkip/)
  assert.match(src, /low_bandwidth_emails === false\) \{/)
})

test('a NULL is_deleted cannot make scheduling report success without writing anything', () => {
  const r = read('app/api/user/delete-account/route.ts')
  assert.match(r, /or\('is_deleted\.is\.null,is_deleted\.eq\.false'\)\.is\('deletion_scheduled_at', null\)/)
  assert.ok(!/set\?\.\[0\]\?\.deletion_scheduled_at \?\? when\.toISOString\(\)/.test(r))
  assert.match(read('lib/accountDeletionCron.ts'), /select\('id'\)\.or\('is_deleted\.is\.null,is_deleted\.eq\.false'\)/)
})
