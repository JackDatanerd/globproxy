-- 0106 — api_keys: service role only.
--
-- 0005 gave every logged-in browser session a select policy on its own api_keys rows,
-- with no column restriction. The dashboard's key list (GET /api/dashboard/api-keys) is
-- gated by requireMfaVerified, but the policy let a session that had NOT passed 2FA
-- step-up read the same rows (key_hash, allowed_ips, last_used_ip, scopes, labels)
-- straight from PostgREST, around that gate. 0054 closed the same gap on
-- webhook_endpoints and 0105 on webhook_deliveries; this closes it on api_keys.
-- Every app read of this table goes through the service role (which bypasses RLS) —
-- the dashboard list route now reads with the admin client — so nothing else changes.
drop policy if exists "Users can view own api keys" on public.api_keys;
-- Belt and braces: even if a policy is ever re-added, the browser roles get no SELECT.
revoke select on public.api_keys from anon, authenticated;

insert into public.schema_migrations (filename) values
  ('0106_api_integrations_api_keys_rls.sql')
on conflict do nothing;
