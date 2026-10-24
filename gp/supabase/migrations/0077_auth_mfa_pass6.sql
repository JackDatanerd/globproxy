-- ─────────────────────────────────────────────────────────────────────
-- 0077 · Auth & MFA — independent pass 6
--  At most ONE open (not cancelled, not completed) 2FA recovery request per
--  account. requestRecovery() was check-then-insert, so two concurrent
--  requests could leave two live confirmation links. The app maps the unique
--  violation to its "already in progress" message.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────
update public.mfa_recovery_requests r
   set cancelled_at = now()
 where r.cancelled_at is null and r.completed_at is null
   and exists (
     select 1 from public.mfa_recovery_requests n
      where n.user_id = r.user_id and n.cancelled_at is null and n.completed_at is null
        and (n.created_at, n.id) > (r.created_at, r.id)
   );

create unique index if not exists mfa_recovery_requests_one_open_idx
  on public.mfa_recovery_requests (user_id)
  where cancelled_at is null and completed_at is null;

insert into public.schema_migrations (filename) values
  ('0077_auth_mfa_pass6.sql')
on conflict do nothing;
