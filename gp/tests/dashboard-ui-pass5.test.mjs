import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('sticky dashboard elements clear the 4rem topbar', () => {
  assert.match(src('components/dashboard/ProxyList.tsx'), /sticky top-\[4\.5rem\]/)
  assert.doesNotMatch(src('components/dashboard/ProxyList.tsx'), /sticky top-2 /)
  assert.match(src('app/dashboard/proxies/new/NewProxyForm.tsx'), /lg:sticky lg:top-20/)
})

test('deletion schedule / cancel refresh the server layout', () => {
  const s = src('app/dashboard/settings/page.tsx')
  assert.equal((s.match(/router\.refresh\(\)/g) ?? []).length >= 2, true)
  assert.match(s, /finally \{[^}]*setExporting\(false\)/s)
})

test('bulk actions treat a declined re-auth as a stop, not a failure', () => {
  assert.match(src('components/dashboard/ProxyList.tsx'), /reauth_required[\s\S]{0,500}declined = true/)
})

test('card indicators use the customer thresholds, not constants', () => {
  const c = src('components/dashboard/ProxyCard.tsx')
  assert.doesNotMatch(c, /const WARN_PCT = 80/)
  assert.match(c, /warnPct = 80, urgentPct = 95/)
  assert.match(src('components/dashboard/ProxyList.tsx'), /warnPct=\{warnPct\}/)
})

test('exported SOCKS5 URLs resolve DNS on the proxy side', () => {
  assert.match(src('components/dashboard/ProxyList.tsx'), /'socks5h' : 'http'/)
})

test('edit tab clears stale regions on country change', () => {
  assert.match(src('components/dashboard/CredentialSettings.tsx'), /setDetail\(null\)\n\s+if \(!country\) return/)
})
