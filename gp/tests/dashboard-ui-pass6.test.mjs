import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('bulk top-up budget check tolerates float dust like the single-card path', () => {
  assert.match(read('components/dashboard/ProxyList.tsx'), /total > availableGb \+ 0\.005/)
})

test('refund request redirects to 2FA verification when the verified session expired', () => {
  const s = read('app/dashboard/billing/page.tsx')
  assert.match(s, /import \{ redirectToMfa \} from '@\/lib\/clientApi'/)
  assert.match(s, /res\.status === 403 && d\?\.code === 'mfa_required'\) redirectToMfa\(d\)/)
})

test('bulk retarget copy does not promise that every session is cleared', () => {
  assert.doesNotMatch(read('components/dashboard/ProxyList.tsx'), /Their state, city and ASN settings are cleared/)
})

test('new-session page tells a lookup failure apart from "no bandwidth"', () => {
  const s = read('app/dashboard/proxies/new/page.tsx')
  assert.match(s, /error: bwError/)
  assert.match(s, /if \(bwError\)/)
})

test('session_low webhook label matches the configurable alert levels', () => {
  assert.doesNotMatch(read('lib/webhookEvents.ts'), /20% \/ 5%/)
})

test('dashboard handlers never show an error toast for a declined re-auth prompt', () => {
  for (const f of [
    'app/dashboard/proxies/new/NewProxyForm.tsx', 'app/dashboard/settings/page.tsx',
    'app/dashboard/api-keys/ApiKeysClient.tsx', 'app/dashboard/api-keys/ApiAccessRequestForm.tsx',
    'components/dashboard/ProxyCard.tsx', 'components/dashboard/ClaimReferralForm.tsx',
    'components/dashboard/CancelPayoutButton.tsx', 'components/dashboard/PayoutMethodForm.tsx',
    'components/dashboard/BillingDetailsForm.tsx', 'components/dashboard/AutoRechargePanel.tsx',
    'components/dashboard/ExportButton.tsx',
  ]) {
    assert.doesNotMatch(read(f), /code !== 'mfa_required'\) toast\.error/, f)
  }
})
