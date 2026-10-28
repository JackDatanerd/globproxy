# FIX PACKAGE — api-integrations pass 9 (c6)

Independent audit of Public API & integrations (api/v1, lib/apiAuth, API keys, webhooks, docs/api).

## L1 (low) — webhook_deliveries readable from a non-2FA browser session
0042 left a select policy on `webhook_deliveries`; dashboard routes gate delivery reads with
`requireMfaVerified`, but PostgREST did not. Migration `0105_api_integrations_deliveries_rls.sql`
drops the policy (service role only, same as webhook_endpoints in 0054). `schema.sql` synced.
App code unchanged: all reads use the service-role client.

**Deploy:** run migration 0105 in Supabase.
**Tests:** tests/api-integrations.test.mjs (+1).
