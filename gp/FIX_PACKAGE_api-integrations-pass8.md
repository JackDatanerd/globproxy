# API & integrations (c6) — pass 8 fixes
1. redeliver-failed: stalest delivery first (last_attempt_at, then created_at) so permanently rejected events no longer block newer failures; docs note updated.
2. Webhook retry: a failed endpoint lookup after the claim gives the attempt back (due again in 60s) instead of burning one of the six attempts.
3. GET /sub-users, /orders, /reseller/invitations: an offset past the end (PostgREST 416 / PGRST103) returns an empty page with the real total instead of a 500 (new pagedQuery helper).
4. GET /reseller/allocations: gb_net rounded to 3 decimals.
5. Docs: retry timing note (5-minute retry task).
No migration.
