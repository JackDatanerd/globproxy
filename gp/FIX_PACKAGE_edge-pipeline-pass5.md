# Edge & request pipeline — pass 5 fixes

Base: 3c17d19. No migration needed.

Bugs
- B1 custom-worker: a failing cron task no longer stops later tasks in the daily chain (cleanup runs after summary fails).
- B2 cron route: `KNOWN` was missing 'invites' and 'resellers' (400 every tick); bandwidth alerts now page, isolate per-account failures and report mail failures.
- B3 middleware: non-JSON/5xx/429/408 auth errors are treated as an outage (503), not a logout (lib/authOutage.ts).
- B4 edgeGuard: chunked request bodies are size-limited (413) instead of bypassing the cap.
- B5 ssrfGuard: 3fff::/20 blocked; DNS SERVFAIL not cached; NXDOMAIN/NODATA rejected when resolvable required. /api/csp-report exempt from the origin guard; nosniff+HSTS on guard responses.

Gaps
- G1 scripts/check-cron-sync.mjs: build fails when wrangler crons, CRON_TASKS and the route's KNOWN drift.
- G2 rateLimit: exact Postgres-backed caps (target 6/10min, user-email 6/h) on top of per-location CF counters.
- G3 per-request nonce CSP on signed-in pages (lib/csp.ts); static policy on public pages. CSP_MODE=enforce remains an explicit later step.
- G4 wrangler: Smart Placement; `ratelimits` stable key.
- G5 Supplier name removed from admin client components.
