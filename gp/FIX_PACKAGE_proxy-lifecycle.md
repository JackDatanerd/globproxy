# Proxy lifecycle fixes (pass 3)

Run supabase/migrations/0079_proxy_lifecycle_pass3.sql BEFORE deploying (new columns, proxy_whitelist_entries, reprovision_credential()).

Gaps: G1 admin Re-provision / Refund for sessions whose proxy vanished upstream (+ orphan list); G2 local IP-whitelist mirror (replayed on re-provision, cron backfill); G3 dashboard live-usage refresh route (shared with v1).
Bugs: usage sync (chunked writes, freshness only when healthy, attempt-bounded limit reconcile, owed notice e-mails, reseller wording), listing ceiling, classifier, strict balance, rotation rollback, delete freeze + usage credit, uuid checks, whitelist missing-upstream 409, auto-topup rate limit, never-synced alert.
