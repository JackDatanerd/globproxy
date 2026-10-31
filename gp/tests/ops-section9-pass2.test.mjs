// Regression guards for the section-9 pass-2 fixes. These read the source on purpose: the
// code under test lives in route handlers that cannot be imported under `node --test`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

test('self-service deletion has no immediate path (the cool-off cannot be skipped)', () => {
  const route = read('app/api/user/delete-account/route.ts')
  assert.ok(!/performAccountDeletion|countInFlightPayments/.test(route))
  assert.ok(!/body\??\.immediate|immediate\s*===\s*true/.test(route))
  const page = read('app/dashboard/settings/page.tsx')
  assert.ok(!/deleteImmediately|immediate:\s*true/.test(page))
})

test('health secret check compares byte lengths before timingSafeEqual', () => {
  const src = read('app/api/health/route.ts')
  assert.ok(/a\.length !== b\.length/.test(src))
  assert.ok(!/given\.length !== expected\.length/.test(src))
  // The failure the old code had: same character count, different byte count.
  const { timingSafeEqual } = await_crypto()
  assert.throws(() => timingSafeEqual(Buffer.from('abcd123é'), Buffer.from('abcd1234')))
})

test('a 95% alert also stamps the 80% flag', () => {
  const src = read('app/api/cron/[task]/route.ts')
  assert.ok(/alerted_95_at: stamp, alerted_80_at: acc\.alerted_80_at \?\? stamp/.test(src))
})

test('deploy.yml: the pre-flight names every required secret and the stock threshold is optional', () => {
  const yml = readFileSync(join(root, '..', '.github/workflows/deploy.yml'), 'utf8')
  const required = yml.match(/secrets: \|\n([\s\S]*?)\n        env:/)[1].split('\n').map((l) => l.trim()).filter(Boolean)
  const verify = yml.match(/for n in ([A-Z_ ]+); do/)[1].split(' ')
  for (const n of required) assert.ok(verify.includes(n), `${n} is deployed as required but not verified up front`)
  assert.ok(!required.includes('STOCK_ALERT_THRESHOLD'))
})

test('the supplier ratchet sees a glob spelling of the name', () => {
  // The pattern is built from character codes (the name must not sit in this public source) and still
  // allows `*` between the two halves, so a glob spelling is caught.
  const src = read('scripts/check-supplier-leak.mjs')
  assert.match(src, /const NAME = new RegExp\(part\(103, 101, 111\) \+ '\[\\\\s_\.\\\\-\*\]\*' \+ part\(110, 111, 100, 101\), 'gi'\)/)
  assert.ok(!/geo\*node/i.test(read('.gitignore')))
})

function await_crypto() { return { timingSafeEqual: process.getBuiltinModule('node:crypto').timingSafeEqual } }
