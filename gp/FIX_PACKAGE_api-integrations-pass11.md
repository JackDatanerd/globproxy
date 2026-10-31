# FIX PACKAGE — api-integrations pass 11 (c6)

Independent re-audit of Public API & integrations. No migrations, no schema changes.

## M1 (medium) — re-sending a webhook's stored URL wiped its failure streak
`updateEndpoint` treated any `url` in a PATCH as a new address: it re-ran DNS and reset the failure streak. The
dashboard edit form always sends `url`, so editing only the description/events of a failing endpoint kept it from
ever reaching the 50-failure auto-disable, and a DNS blip could block saving an unchanged address. Only a different
address now re-validates and resets; a url-only no-op answers with the endpoint. (lib/webhookEndpoints.ts)

## L1 (low–medium, security) — webhook-change e-mail was throttled per event type, not per origin
A legitimate dashboard edit silenced the owner notice for an API-key change made within 10 minutes. The throttle is
now per (event, via, key id, host), capped at 5 notices per window per origin type. security_events rows are still
written every time. (lib/integrationAudit.ts)

## L2 — `created_after` / `created_before` accepted anything `Date.parse` does
"1", "5", "2026", "2026-02-30" silently filtered on a date nobody meant. Strict ISO 8601 now (400 otherwise); an
offset-less date-time is UTC. (lib/apiHelpers.ts, lib/cursor.ts `isoToUtcString`)

## L3 — cursor timestamp with an impossible offset (`+25:00`) reached Postgres → 500
Offsets beyond ±14:00 are now a 400. (lib/cursor.ts)

## L4 — a literal `*` in the sub-user label search matched everything
PostgREST rewrites every `*` in an ilike value to `%`. It is now the single-character wildcard. (lib/apiHelpers.ts)

## L5 — customers' own `*.workers.dev` receivers were refused as "GlobProxy itself"
Still refused (we can't tell our Workers from theirs by name) but with an accurate message, and the endpoint address
rules are now documented. (lib/ssrfGuard.ts, app/docs/api/page.tsx)

**Tests:** tests/c6-round3-fixes.test.mjs (+6). tsc clean; full suite 370/370; supplier-leak ratchet and docs-sync OK.
