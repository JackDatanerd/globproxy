import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

test('auto-recharge never charges an account whose deletion is scheduled', () => {
  const src = read('lib/autoRecharge.ts')
  assert.match(src, /select\('is_deleted, is_suspended, deletion_scheduled_at'\)/)
  assert.match(src, /if \(profile\.deletion_scheduled_at\) \{ await defer\(supabase, userId\); return 'skipped' \}/)
})

test('canary reports a configured-but-unreadable test account as an error, not a skip', () => {
  const src = read('app/api/cron/[task]/route.ts')
  assert.ok(!/reason: 'canary_user_not_found'/.test(src))
  assert.match(src, /canary could not read its test account/)
  assert.match(src, /canary_user_id is set but that account does not exist/)
})

test('cleanup reports the auto top-up sweep failure and counts what it closed', () => {
  const src = read('app/api/cron/[task]/route.ts')
  assert.match(src, /abandonAutoErr && 'auto top-up orders'/)
  assert.match(src, /\(abandoned\?\.length \?\? 0\) \+ \(abandonedAuto\?\.length \?\? 0\)/)
})

test('usage-sync stale alert is claimed atomically before mailing and re-armed on refusal', () => {
  const src = read('lib/cronHealth.ts')
  const i = src.indexOf("insert({ key: 'usage_sync_stale_alerted_at'")
  assert.ok(i > 0 && i < src.indexOf('[USAGE SYNC STALE]'))
  assert.match(src, /claimErr\.code === '23505'/)
  assert.match(src, /if \(!delivered\) \{\s*await supabase\.from\('platform_settings'\)\.delete\(\)\.eq\('key', 'usage_sync_stale_alerted_at'\)/)
})

test('deploy job only runs from main', () => {
  const wf = readFileSync(join(root, '..', '.github/workflows/deploy.yml'), 'utf8')
  assert.match(wf, /deploy:\n    needs: check-schema\n(?:.*\n)*?    if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/)
})
