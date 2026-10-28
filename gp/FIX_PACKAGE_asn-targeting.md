# FIX PACKAGE — ASN / ISP targeting

## Problem
Every session targeted with an ISP (ASN) plus a state or city failed to connect with
"Request failed with status code 465" (no proxies available for the requested targeting).
Country-only worked; country + ASN mostly worked; state + city + ASN almost always failed.
ISP targeting is country-wide on the network side — stacked on one city it asks for one ISP's
addresses inside one city, which almost never exists.

## Decision
Location wins. When a state or city is set the ASN is not sent. ISP targeting is country + ASN only.

## Changes
- lib/proxyEndpoint.ts — comments corrected (the old "confirmed" stacked-username example only proved the syntax is accepted, not that the pool can serve it); buildProxyUsername only emits `-asn-` when a country is set and no state/city
  (repairs every already-saved session without a migration); new asnApplies(); validateTargeting rejects
  ASN without a country and ASN with a state/city (optional allowLegacyAsnCombo flag for untouched legacy rows).
- lib/apiValidation.ts — parseTargeting passes allowLegacyAsnCombo through (create is always strict).
- lib/credentials.ts — edit path tolerates a legacy ASN+location row only while country/state/city/asn are unchanged.
- components/dashboard/AsnPicker.tsx — blockedReason prop (disabled box + reason); stale half-typed search cleared when the box becomes blocked; note that an ISP can have no
  addresses online ("no proxies available" → pick another ISP or use the country only).
- app/dashboard/proxies/new/NewProxyForm.tsx — choosing a region clears the ISP; duplicated session with both starts
  with the location; submit never sends both.
- components/dashboard/CredentialSettings.tsx — same rule on the Edit tab.
- app/docs/api/page.tsx, lib/openapi.ts, lib/blog/posts.ts — documented: ASN is country-wide, not combinable with
  state/city (400), how to move between the two on PATCH.
- tests/asn-targeting.test.mjs — 10 regression tests.

## Verified
npm test (205 pass), tsc --noEmit, check:api-docs, check:supplier, check:schema, check:cron.
No migration, no env change, no supplier name in any customer-facing text.
