-- ─────────────────────────────────────────────────────────────────────
-- 0115 · Cron, account deletion & ops — independent pass 6
--
--  1. Deleted accounts kept personal data on their API-key rows: revoking a key leaves
--     last_used_ip (a source IP), allowed_ips (the customer's own allow-list) and the label
--     they typed. purgeAccountSecrets() now clears them; this back-fills accounts deleted
--     before. Revoked keys can never authenticate again, so nothing depends on these values.
--
-- Idempotent. Safe to apply before or after the deploy.
-- ─────────────────────────────────────────────────────────────────────
update public.api_keys k
   set last_used_ip = null,
       allowed_ips  = '{}'::text[],
       label        = 'Revoked',
       revoked_at   = coalesce(k.revoked_at, now())
  from public.profiles p
 where p.id = k.user_id
   and coalesce(p.is_deleted, false)
   and (k.last_used_ip is not null or cardinality(k.allowed_ips) > 0 or k.label <> 'Revoked' or k.revoked_at is null);

insert into public.schema_migrations (filename) values
  ('0115_cron_deletion_ops_pass6.sql')
on conflict do nothing;
