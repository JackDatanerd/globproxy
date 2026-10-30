import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Static guards for the database-layer close-out (migration 0112). The behavioural proof —
// two real databases built and compared — lives in scripts/check-db-parity.mjs (npm run check:db);
// these keep the wiring around it from rotting without needing that test database installed.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const mig = read('supabase/migrations/0112_database_layer_closeout.sql')
const schema = read('supabase/schema.sql')

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

test('the browser only ever writes profile columns that migration 0112 lets authenticated update', () => {
  const m = mig.match(/grant update \(([^)]*)\)\s+on public\.profiles to authenticated/i)
  assert.ok(m, '0112 must grant UPDATE on an explicit column list')
  const allowed = new Set(m[1].split(',').map((x) => x.trim()).filter(Boolean))
  assert.ok(allowed.size >= 6)
  let found = 0
  for (const f of [...walk(path.join(root, 'app')), ...walk(path.join(root, 'components'))]) {
    const src = fs.readFileSync(f, 'utf8')
    for (const call of src.matchAll(/createClient\(\)\s*\.from\('profiles'\)\s*\.update\(\{([^}]*)\}\)/g)) {
      found++
      for (const part of call[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        let keys = []
        if (part.startsWith('...')) {
          const obj = src.match(new RegExp(`const ${part.slice(3).trim()}\\s*=\\s*\\{([^}]*)\\}`))
          assert.ok(obj, `${path.relative(root, f)}: cannot resolve ${part}`)
          keys = [...obj[1].matchAll(/([a-z_]+)\s*:/g)].map((k) => k[1])
        } else keys = [part.split(':')[0].trim()]
        for (const k of keys) assert.ok(allowed.has(k), `${path.relative(root, f)} writes profiles.${k} from the browser, but 0112 does not grant UPDATE on it`)
      }
    }
  }
  assert.ok(found >= 4, 'expected to find the settings-page profile writes')
})

test('profiles loses INSERT / DELETE / TRUNCATE for the browser roles and keeps the column-level SELECT for marketing_emails', () => {
  assert.match(mig, /revoke insert, update, delete, truncate on public\.profiles from anon, authenticated/i)
  assert.match(mig, /grant select \(marketing_emails\) on public\.profiles to authenticated/i)
  // The fold into schema.sql must carry both, or a rebuilt database loses them again.
  assert.match(schema, /grant select \(marketing_emails\) on public\.profiles to authenticated/i)
  assert.match(schema, /0112_database_layer_closeout/)
})

test('the default-privilege revoke is GLOBAL — a schema-scoped one cannot remove the PUBLIC EXECUTE on new functions', () => {
  const globalRevoke = mig.split('\n').filter((l) => /^\s*alter default privileges/i.test(l) && /revoke execute on functions from public/i.test(l))
  assert.equal(globalRevoke.length, 1)
  assert.doesNotMatch(globalRevoke[0], /in schema/i)
})

test('the stock-return function locks the transfer row before the accounts, like the reclaim does', () => {
  const body = mig.slice(mig.indexOf('create or replace function public.return_reseller_stock_on_client_delete'))
  const lockTransfer = body.indexOf('from public.reseller_transfers where id = c.id for update')
  const lockAccounts = body.indexOf('perform 1 from public.bandwidth_accounts')
  assert.ok(lockTransfer > 0 && lockAccounts > lockTransfer, 'transfer row must be locked and re-read before the account rows')
})

test('the real-database parity check is wired into npm scripts and CI, and its baseline ships', () => {
  assert.match(read('package.json'), /"check:db":\s*"node scripts\/check-db-parity\.mjs"/)
  const wf = fs.readFileSync(path.join(root, '..', '.github/workflows/schema-drift-check.yml'), 'utf8')
  assert.match(wf, /check-db-parity\.mjs/)
  assert.match(wf, /@electric-sql\/pglite@\d+\.\d+\.\d+/, 'the test database must be pinned to an exact version')
  assert.ok(fs.existsSync(path.join(root, 'supabase/baseline/pre-0001-schema.sql')))
})
