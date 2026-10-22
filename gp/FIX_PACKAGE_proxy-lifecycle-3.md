# Proxy lifecycle — independent pass 2 (fix round) — migration 0064

Rebased onto `4ae6174` (Dashboard UI pass 1). My earlier numbering (0062) collided with
`0062_api_integrations_closeout`, so this migration is **0064**. The whitelist-output projection
was fixed concurrently by the API & integrations closeout; that version is kept as is.

## Deploy order
1. Run `supabase/migrations/0064_proxy_lifecycle_pass2.sql` (schema.sql is already appended).
2. Deploy the code.
3. Run the live checks below once.

## Feature gaps closed
| # | What |
|---|------|
| G1 | **Provisioning can no longer orphan sub-users.** The upstream username/password are decided and saved on the pending row (`provision_username/_password`, hidden from customers) *before* the supplier is called. A retry looks for that sub-user first and adopts it (`createOrAdoptSubUser`); a duplicate-name rejection also falls back to adoption; an unreadable listing aborts the attempt instead of creating blind. Delete-guard: a sub-user another row already points at is never cleaned up. The orphan sweep ignores adoptable names and now **auto-deletes** untracked `gp_` sub-users with zero traffic after 24h (max 5/run); any with usage stay for a human. |
| G2 | **Live cap behind the database is escalated.** `limit_sync_failed_since` starts when a committed allocation can't be applied upstream and clears when it lands. After 30 min the owner (supplier-neutral wording) and the admin are told once (`alertStuckLimitSync`, runs in the `provision` cron). `reconcileLimitSync` now re-reads `gb_allocated` right before the PATCH (no stale overwrite). |
| G3 | Whitelist changes now fire `whitelist_changed` (dashboard + v1, single + bulk). **Semantics still need the live test below — not resolvable from code.** |
| G4 | **Password rotation is verified on every call**: after the provider PATCH, the proxy itself is probed — new password accepted → commit; new refused but old still works → provider ignored it, nothing committed, 502; neither → commit on the provider echo. Now on by default; `PASSWORD_ROTATION_ENABLED=false` is the kill switch. |
| G5 | **Usage history uses a local ledger** (`usage_daily` + `record_usage_deltas`, credited by every usage sync and by the v1 live-usage refresh). Covers deleted sessions and accounts with >10 sessions; once the ledger reaches back past the range start the per-session supplier series calls are skipped. Before that, each day takes max(local, supplier). Response gains `series_source`. Ledger prunes at 400 days in the daily cleanup. |
| G6 | New events `session_updated`, `session_password_rotated`, `whitelist_changed` (constraint, constants, docs). |

## Bugs fixed
| # | What |
|---|------|
| B1 | API `connection_username` for sticky sessions is now stable (derived from the credential id, same as the dashboard) instead of a new random session id per call. |
| B2 | Whitelist projection — already fixed by the concurrent pass; kept. |
| B3 | Exhaustion notices claim the flag **before** sending, so the admin "sync all" button overlapping the cron can't double-send. |
| B4 | "Retry now" no longer answers a false "already in progress" for 2 minutes after a failed create (`provisioning_claimed_at` is no longer stamped at creation). |
| B5 | Amounts that round to 0 are rejected up front; a release under 0.01 GB is refused before the live cap is touched. |
| B6 | Host-country `truncated` only when a row really exists beyond the cap; dashboard session routes now rate-limited; `used_gb` keeps suspended / customer-paused sessions. |

## Live checks (needs your Geonode account)
1. **Username format** — `/api/admin/debug-geonode` now returns `username_matches_requested`. If `false`, tell me: customers would see the rewritten name and the orphan sweep wouldn't match.
2. **Whitelist semantics** — whitelist a throwaway sub-user's IP A. From IP B (not listed) connect with valid credentials: does it work? From IP A with *no* credentials: does it work? Restriction = B refused. If A connects without credentials, the feature is credential-less IP auth and the UI wording must change.
3. **Duplicate-name error** — create the same username twice via the debug route; confirm the status/text matches `isDuplicateSubUserError` (400/409/422 + "exists/already/taken/duplicate/in use/unique"). If not, adoption still works through the retry-time listing, only the in-call fallback is affected.
4. **Host-country granularity** — does `per-subuser-host-country` at `granularity=day` return one row per day per host? If yes, the breakdown table needs aggregating.
