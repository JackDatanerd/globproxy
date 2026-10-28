import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

test('limit reconcile orders suspended caps first and rotates, instead of id order with a hard stop', () => {
  const s = read('lib/usageSync.ts')
  assert.match(s, /suspendedDrift/)
  assert.match(s, /\[\.\.\.rotate\(suspendedDrift\), \.\.\.rotate\(limitDrift\)\]/)
})

test('limit-sync retry and whitelist crons rotate through a wider window', () => {
  assert.match(read('lib/credentials.ts'), /\.order\('id'\)\.limit\(limit \* 8\)/)
  const w = read('lib/whitelistMirror.ts')
  assert.equal((w.match(/rotatedBatch\(rows, limit\)/g) || []).length, 2)
  assert.match(w, /mirrorWhitelist\(admin, r\.id, r\.user_id, ips, r\.upstream_sub_user_id\)/)
})

test('whitelist routes: uuid-validate and surface database errors as 503', () => {
  for (const f of ['app/api/dashboard/proxies/[id]/whitelist/route.ts', 'app/api/dashboard/proxies/[id]/whitelist/bulk/route.ts']) {
    const s = read(f)
    assert.match(s, /isUuidString\(id\)/)
    assert.match(s, /if \(error\) throw new LookupError\(\)/)
    assert.match(s, /status: 503/)
  }
})

test('failed provisioning frees the claim; delete ledger baseline is re-read', () => {
  assert.match(read('lib/credentials.ts'), /pending_reason: classifyUpstreamError\(e\), provisioning_claimed_at: null/)
  assert.match(read('lib/credentials.ts'), /gb: used - ledgerBaseline/)
})

test('both bulk-pause routes only trust the up-front sync when it was complete', () => {
  for (const f of ['app/api/dashboard/proxies/bulk-action/route.ts', 'app/api/v1/sub-users/bulk-action/route.ts']) {
    assert.match(read(f), /r\.usage_fetch_failures === 0 && r\.usage_write_ok && r\.recalc_ok/)
  }
})

test('already-told session_limit sessions cost no per-tick database call', () => {
  const s = read('lib/autoTopup.ts')
  assert.match(s, /auto_topup_alert_kind/)
  assert.match(s, /alreadyTold/)
})

test('migration 0102: bulk usage write skips rows refreshed after the read', () => {
  const m = read('supabase/migrations/0102_proxy_lifecycle_pass11.sql')
  assert.match(m, /r\.synced_at > r\.read_at/)
  assert.match(m, /for update of pc/)
  assert.match(read('lib/usageSync.ts'), /read_at: readAt/)
})
