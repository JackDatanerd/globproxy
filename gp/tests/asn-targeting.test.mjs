import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildProxyUsername, validateTargeting, asnApplies,
  ASN_NEEDS_COUNTRY_ERROR, ASN_WITH_LOCATION_ERROR,
} from '../lib/proxyEndpoint.ts'
import { leaksSupplier } from '../lib/supplierGuard.ts'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// The network answers "no proxies available" (HTTP 465) when an ISP is requested inside one
// state/city — that is what every ASN-targeted session with a location was failing with.
const base = 'gp_abc123'

test('country + ASN is sent as country-wide ISP targeting', () => {
  assert.equal(
    buildProxyUsername(base, { country: 'au', asn: '1221', session_type: 'rotating' }),
    'gp_abc123-type-residential-country-au-asn-1221',
  )
})

test('a state or city wins over the ASN: the ASN is left out of the username', () => {
  const withState = buildProxyUsername(base, { country: 'au', state: 'newsouthwales', asn: '1221' })
  assert.equal(withState, 'gp_abc123-type-residential-country-au-state-newsouthwales')
  const withBoth = buildProxyUsername(base, { country: 'au', state: 'newsouthwales', city: 'newcastle', asn: '1221' })
  assert.equal(withBoth, 'gp_abc123-type-residential-country-au-state-newsouthwales-city-newcastle')
  assert.ok(!withBoth.includes('-asn-'))
  const cityOnly = buildProxyUsername(base, { country: 'au', city: 'newcastle', asn: '1221' })
  assert.ok(!cityOnly.includes('-asn-'))
})

test('an ASN with no country is never sent', () => {
  assert.equal(buildProxyUsername(base, { asn: '1221' }), 'gp_abc123-type-residential')
})

test('sticky sessions keep lifetime and session after the ASN, and drop it with a location', () => {
  assert.equal(
    buildProxyUsername(base, { country: 'au', asn: '1221', session_type: 'sticky', sticky_duration: 30 }, 'abcDEF12'),
    'gp_abc123-type-residential-country-au-asn-1221-lifetime-30-session-abcDEF12',
  )
  assert.equal(
    buildProxyUsername(base, { country: 'au', state: 'victoria', asn: '1221', session_type: 'sticky', sticky_duration: 30 }, 'abcDEF12'),
    'gp_abc123-type-residential-country-au-state-victoria-lifetime-30-session-abcDEF12',
  )
})

test('asnApplies mirrors the builder', () => {
  assert.equal(asnApplies({ country: 'au', asn: '1221' }), true)
  assert.equal(asnApplies({ country: 'au', state: 'victoria', asn: '1221' }), false)
  assert.equal(asnApplies({ country: 'au', city: 'x', asn: '1221' }), false)
  assert.equal(asnApplies({ asn: '1221' }), false)
  assert.equal(asnApplies({ country: 'au', asn: '' }), false)
})

test('writes: an ASN needs a country and cannot ride along with a state or city', () => {
  assert.equal(validateTargeting({ country: 'au', asn: '1221' }), null)
  assert.equal(validateTargeting({ country: 'au', state: 'victoria' }), null)
  assert.equal(validateTargeting({ asn: '1221' }), ASN_NEEDS_COUNTRY_ERROR)
  assert.equal(validateTargeting({ country: 'au', state: 'victoria', asn: '1221' }), ASN_WITH_LOCATION_ERROR)
  assert.equal(validateTargeting({ country: 'au', state: 'victoria', city: 'x', asn: '1221' }), ASN_WITH_LOCATION_ERROR)
  assert.equal(validateTargeting({ country: 'au', state: 'victoria', asn: '' }), null)
  assert.equal(validateTargeting({ country: 'au', state: 'victoria', asn: null }), null)
  // format errors still come first
  assert.equal(validateTargeting({ country: 'au', asn: 'abc' }), 'ASN must be numeric.')
})

test('a legacy ASN+location row can still be relabelled, but not set or changed', () => {
  const legacy = { country: 'au', state: 'victoria', asn: '1221' }
  assert.equal(validateTargeting(legacy, { allowLegacyAsnCombo: true }), null)
  assert.equal(validateTargeting({ asn: '1221' }, { allowLegacyAsnCombo: true }), null)
  assert.equal(validateTargeting(legacy), ASN_WITH_LOCATION_ERROR)
  // the flag never relaxes format checks
  assert.equal(validateTargeting({ country: 'au', asn: 'abc' }, { allowLegacyAsnCombo: true }), 'ASN must be numeric.')
})

test('the edit path only tolerates the legacy combination while country/state/city/asn are untouched', () => {
  const src = read('lib/credentials.ts')
  assert.match(src, /const cityChanged = 'city' in b && normGeo\(b\.city\) !== \(cred\.city \?\? null\)/)
  assert.match(src, /allowLegacyAsnCombo: !\(asnChanged \|\| countryChanged \|\| stateChanged \|\| cityChanged\)/)
  assert.match(read('lib/apiValidation.ts'), /validateTargeting\(\{ country: country\.value, state: state\.value, city: city\.value, asn \}, \{ allowLegacyAsnCombo: opts\.allowLegacyAsnCombo \}\)/)
})

test('the forms follow "location wins": choosing a region clears the ISP and the ISP box is blocked', () => {
  const form = read('app/dashboard/proxies/new/NewProxyForm.tsx')
  assert.match(form, /asn: v \? '' : f\.asn/)
  assert.match(form, /form\.asn && form\.country && !form\.state && !form\.city \? form\.asn : undefined/)
  assert.match(form, /blockedReason=/)
  const edit = read('components/dashboard/CredentialSettings.tsx')
  assert.match(edit, /if \(e\.target\.value\) setAsn\(''\)/)
  assert.match(edit, /blockedReason=/)
  assert.match(read('components/dashboard/AsnPicker.tsx'), /disabled=\{!!blockedReason\}/)
})

test('customer-facing ASN text never names the upstream supplier', () => {
  for (const f of ['components/dashboard/AsnPicker.tsx', 'components/dashboard/CredentialSettings.tsx', 'app/dashboard/proxies/new/NewProxyForm.tsx']) {
    assert.equal(leaksSupplier(read(f)), false, f)
  }
})

test('help articles no longer present a city plus an ISP as a valid combination', () => {
  const posts = read('lib/blog/posts.ts')
  assert.doesNotMatch(posts, /One city plus one (ISP|internet provider)/)
  assert.doesNotMatch(posts, /narrow city plus a narrow ISP/)
  assert.doesNotMatch(posts, /drop the ISP, then the city/)
  // every copy of the username explainer says an ISP replaces state/city
  const explainers = posts.match(/an ISP appears as -asn-<number> if you chose one[^.]*\./g) ?? []
  assert.ok(explainers.length >= 1)
  for (const e of explainers) assert.match(e, /instead of a state or city/)
})

test('session_updated lists only fields that really changed, and a no-op save sends no event', () => {
  const src = read('lib/credentials.ts')
  assert.match(src, /!sameValue\(patch\[k\], \(cred as Record<string, unknown>\)\[k\]\)/)
  assert.match(src, /if \(changed\.length === 0\) return \{ ok: true, data: \{ cred: data \} \}/)
  assert.doesNotMatch(src, /changed: Object\.keys\(patch\)\.filter/)
})
