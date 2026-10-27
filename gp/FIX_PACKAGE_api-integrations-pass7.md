# API & integrations (c6) — pass 7 fixes
1. api-keys GET/PATCH/DELETE and webhooks GET now require MFA verification; DELETE also gets a rate limit + active-user check.
2. Key rotation requires API access (canUseApi).
3. Key edits no longer re-run allocate rules on label/expiry-only edits; an allocate key can keep its scope after owner downgrade.
4. Docs/OpenAPI: activity log also records rejected attempts.
5. usage/history: empty ?days= uses the default.
6. Webhook retries: attempt counter advances at claim time; rows at MAX_ATTEMPTS are failed instead of looping.
7. Housekeeping claim is now an atomic compare-and-set.
No migration.
