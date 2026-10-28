# FIX PACKAGE — ASN / ISP targeting, round 2 (independent pass)

## Found
1. Help articles still described "one city plus one ISP" as a valid combination (4 places) and told
   customers to "drop the ISP, then the city". The earlier one-line fix to the username explainer in
   lib/blog/posts.ts was also LOST: the help-article push (053cf1f) replaced the whole file from an older copy.
2. session_updated webhooks listed every key of the PATCH body as "changed". The dashboard Edit tab sends
   every field on every save, so a plain relabel reported country/state/city/asn/protocol/session_type/... as
   changed, and a save that changed nothing still fired an event.

## Changes
- lib/blog/posts.ts — five passages reworded (city/state widening, ISP is country-wide and never combined
  with a state/city, what to do on "no proxies available"); username explainer re-applied.
- lib/credentials.ts — updateCredentialSettings: `changed` = only fields whose value differs from the stored
  session; no event when nothing changed.
- tests/asn-targeting.test.mjs — 2 more guards (articles, changed list). 12 tests total.

## Verified
npm test (206 pass), tsc --noEmit, check:fast. Built on c4e22cd.
NOTE: lib/blog/posts.ts is edited by other sessions as a whole-file tar. `git pull` right before extracting.
