import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

test('the supplier name no longer appears in application source (the repository is public)', () => {
  for (const f of ['lib/upstream.ts', 'app/api/health/route.ts', 'app/api/admin/debug-upstream/route.ts']) {
    assert.ok(!/geo[\s_.\-*]*node/i.test(read(f)), `${f} names the supplier`)
  }
  const up = read('lib/upstream.ts')
  assert.match(up, /UPSTREAM_API_BASE/)
  assert.match(up, /UPSTREAM_MONITOR_BASE/)
})

test('account purge also removes support threads that were never linked to the account', () => {
  const src = read('lib/accountDeletion.ts')
  assert.match(src, /signInEmail = au\?\.user\?\.email/)
  assert.match(src, /from\('inbox_threads'\)\.delete\(\)\.eq\('customer_email', signInEmail\)/)
})

test('a suspended account cannot schedule its own deletion', () => {
  const src = read('app/api/user/delete-account/route.ts')
  const i = src.indexOf('profile.is_suspended')
  assert.ok(i > 0 && i < src.indexOf('deletion_scheduled_at: when'))
})

test('cancelling after a part-way deletion tells the customer sessions were removed', () => {
  const route = read('app/api/user/delete-account/cancel/route.ts')
  assert.match(route, /startsWith\('release:'\)/)
  assert.ok(route.indexOf("select('deletion_last_error')") < route.indexOf('.update({'))
  assert.match(read('lib/accountDeletionEmail.ts'), /sessionsReleased/)
  assert.match(read('app/api/cron/[task]/route.ts') + read('lib/accountDeletionCron.ts'), /recordFailure\(`\$\{result\.stage\}: \$\{result\.error\}`\)/)
})
