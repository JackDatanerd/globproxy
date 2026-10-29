import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('an over-long SWIFT is refused, not silently dropped', () => {
  const s = read('app/api/dashboard/update-payout-method/route.ts')
  assert.match(s, /swiftRaw\.length > 20/)
  assert.match(s, /SWIFT\/BIC code is too long/)
})

test('a roster page past the end redirects to the first page of the same view', () => {
  const s = read('app/reseller/users/page.tsx')
  assert.match(s, /page > 1 && \(clientsErr \|\| !\(clients as any\[\] \| null\)\?\.length\)/)
  assert.match(s, /redirect\(qs \? `\/reseller\/users\?\$\{qs\}` : '\/reseller\/users'\)/)
})

test('the low-stock sweep includes admin accounts, in the migration and in schema.sql', () => {
  for (const f of ['supabase/migrations/0109_reseller_low_stock_admin.sql', 'supabase/schema.sql']) {
    const sql = read(f)
    const fn = sql.slice(sql.lastIndexOf('create or replace function public.reseller_low_stock_due'))
    assert.match(fn, /p\.role in \('reseller', 'admin'\) and p\.reseller_low_stock_gb is not null/)
  }
})
