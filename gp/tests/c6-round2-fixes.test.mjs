import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

test('R1: retry budget is spent on attempts, not on rows selected', () => {
  const src = read('lib/webhooks.ts')
  assert.match(src, /async function selectDueGroups/)
  assert.match(src, /for \(let pass = 0; pass < MAX_RETRY_PASSES && retried < limit; pass\+\+\)/)
  assert.match(src, /selectDueGroups\(supabase, nowIso, limit - retried, handled, stopped\)/)
  assert.match(src, /if \(hitStreak\) stopped\.add\(/)
  // keyset paging, so later rounds do not re-read rows already taken
  assert.match(src, /next_attempt_at\.gt\./)
})

test('R2: a failed record_webhook_attempt RPC is logged', () => {
  const src = read('lib/webhooks.ts')
  assert.match(src, /error: recAttemptErr \} = await supabase\.rpc\('record_webhook_attempt'/)
  assert.match(src, /if \(recAttemptErr\) console\.error/)
})

test('R3: reminder cooldown answers 429 with Retry-After', () => {
  assert.match(read('lib/resellerAllocation.ts'), /retryAfterSeconds\?: number/)
  assert.match(read('lib/resellerAllocation.ts'), /retryAfterSeconds: Math\.min\(secs, 86_400\)/)
  assert.match(read('app/api/v1/reseller/invitations/[id]/remind/route.ts'), /'Retry-After': String\(r\.retryAfterSeconds\)/)
})

test('R4: redeliver-failed charges writes for the batch actually sent', () => {
  const route = read('app/api/v1/webhooks/[id]/deliveries/redeliver-failed/route.ts')
  assert.doesNotMatch(route, /consumeWrites\(limit - 1\)/)
  assert.match(route, /consumeWrites\(n - 1\)/)
  assert.match(read('lib/webhooks.ts'), /authorize\(batch\.length\)/)
})

test('R5: PATCH invitation validates the id instead of sniffing messages', () => {
  const src = read('app/api/v1/reseller/invitations/[id]/route.ts')
  assert.match(src, /if \(!isUuid\(id\)\) return apiError\(404/)
  assert.doesNotMatch(src, /smaller amount\|Enter the new amount/)
})

test('R6: docs status table lists 413', () => {
  assert.match(read('app/docs/api/page.tsx'), /\['413', 'Payload Too Large'/)
})
