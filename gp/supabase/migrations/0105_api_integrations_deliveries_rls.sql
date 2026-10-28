-- 0105 — webhook_deliveries: service role only.
--
-- 0042 gave every logged-in browser session a select policy on its own delivery
-- rows. Every dashboard read of deliveries (payload, response_body, status) is gated
-- by requireMfaVerified, but the policy let a session that had NOT passed 2FA
-- step-up read the same columns straight from PostgREST. 0054 closed the same gap
-- on webhook_endpoints; this closes it on deliveries. All app reads go through the
-- service role, which bypasses RLS, so nothing in the app changes.
drop policy if exists "Users can view own webhook deliveries" on public.webhook_deliveries;

insert into public.schema_migrations (filename) values
  ('0105_api_integrations_deliveries_rls.sql')
on conflict do nothing;
