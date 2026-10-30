-- ============================================================
-- 0114 — Database layer close-out, round 2 (independent audit pass, Oct 2026)
-- ============================================================
-- Found by building schema.sql into a real Postgres and exercising it as the `authenticated`
-- role (the role every browser holds), not by reading the SQL:
--
--  1. Free text was bounded only by the API routes, but the browser reaches PostgREST directly:
--     a 5 MB proxy_sessions.label and a 1 MB profiles.company_name were accepted (the session
--     trigger caps ROWS per credential, not their size; company_name is printed on invoices and
--     in emails). The same limits the app already enforces (label 100, names 100 — 200 here for
--     headroom) are now CHECK constraints. Existing over-long values are trimmed first.
--  2. proxy_sessions: INSERT was guarded by a trigger (sticky-only, caps, active account) but
--     UPDATE / DELETE were guarded only by "row is yours". A customer could re-parent a session
--     onto a rotating credential, un-terminate rows to run past the 200-live cap (205 reached),
--     and a suspended / deleted account could still edit and delete its sessions. credential_id,
--     user_id, session_token and created_at are now frozen for client roles, a terminated session
--     stays terminated (the API already treats it as gone), and an inactive account cannot write.
--  3. protect_order_columns restored every orders column except `id`: an owner cancelling their
--     own pending order could rewrite its id, so a webhook / reconcile lookup by id would miss an
--     order that was then paid. `id` is frozen too, and check-db-parity now fails if any orders
--     column other than payment_status is ever missing from that trigger.
--  4. Defence in depth: anon / authenticated held INSERT / UPDATE / DELETE on ~45 tables whose
--     only protection was "RLS has no policy", plus TRUNCATE (not subject to RLS), REFERENCES and
--     TRIGGER everywhere, and USAGE/UPDATE on every sequence. Any write privilege with no RLS
--     policy for that command is revoked, as are TRUNCATE / REFERENCES / TRIGGER / MAINTAIN and the
--     sequence rights. SELECT is deliberately left alone (policy sub-queries need it, and a
--     no-policy SELECT already returns nothing). check-db-parity asserts this from now on, so the
--     next table added with default privileges fails CI until it carries its own REVOKE.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────

-- 1 ───────────────────────────────────────────────────────────────────
update public.proxy_sessions set label = left(label, 100) where char_length(label) > 100;
update public.profiles set full_name = left(full_name, 200) where char_length(full_name) > 200;
update public.profiles set company_name = left(company_name, 200) where char_length(company_name) > 200;

alter table public.proxy_sessions drop constraint if exists proxy_sessions_label_len;
alter table public.proxy_sessions add constraint proxy_sessions_label_len check (char_length(label) <= 100);
alter table public.profiles drop constraint if exists profiles_name_len;
alter table public.profiles add constraint profiles_name_len
  check (char_length(coalesce(full_name, '')) <= 200 and char_length(coalesce(company_name, '')) <= 200);

-- 2 ───────────────────────────────────────────────────────────────────
create or replace function public.protect_proxy_session_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_inactive boolean;
begin
  if auth.uid() is null then
    return new; -- service-role client (cron, account deletion, admin)
  end if;

  new.id            := old.id;
  new.credential_id := old.credential_id;
  new.user_id       := old.user_id;
  new.session_token := old.session_token;
  new.created_at    := old.created_at;
  -- A terminated session is gone; it cannot be revived to dodge the live-session cap.
  if old.terminated_at is not null then
    new.terminated_at := old.terminated_at;
  end if;

  select coalesce(is_suspended, false) or coalesce(is_deleted, false) into v_inactive
  from public.profiles where id = old.user_id;
  if coalesce(v_inactive, false) then
    raise exception 'Account is not active' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_proxy_session_columns() from public, anon, authenticated;
grant execute on function public.protect_proxy_session_columns() to service_role;

drop trigger if exists proxy_sessions_protect_columns on public.proxy_sessions;
create trigger proxy_sessions_protect_columns
  before update on public.proxy_sessions
  for each row execute function public.protect_proxy_session_columns();

drop policy if exists "Users can delete their own sessions" on public.proxy_sessions;
create policy "Users can delete their own sessions" on public.proxy_sessions for delete
  using (
    auth.uid() = user_id
    and not exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and (coalesce(p.is_suspended, false) or coalesce(p.is_deleted, false))
    )
  );

-- 3 ───────────────────────────────────────────────────────────────────
create or replace function public.protect_order_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  caller_is_admin boolean;
begin
  if auth.uid() is null then
    return new; -- service-role client (webhook, cron, activateBandwidth)
  end if;

  select (role = 'admin') into caller_is_admin
  from public.profiles where id = auth.uid();

  if coalesce(caller_is_admin, false) then
    return new;
  end if;

  new.id                           := old.id; -- 0114: was missing
  new.user_id                      := old.user_id;
  new.plan_id                      := old.plan_id;
  new.gb_amount                    := old.gb_amount;
  new.amount_usd                   := old.amount_usd;
  new.payment_method               := old.payment_method;
  new.paystack_reference           := old.paystack_reference;
  new.bandwidth_credited           := old.bandwidth_credited;
  new.paid_at                      := old.paid_at;
  new.created_at                   := old.created_at;
  new.invoice_number               := old.invoice_number;
  new.failure_reason               := old.failure_reason;
  new.failed_at                    := old.failed_at;
  new.is_canary                    := old.is_canary;
  new.refunded_usd                 := old.refunded_usd;
  new.refunded_at                  := old.refunded_at;
  new.reconcile_checked_at         := old.reconcile_checked_at;
  new.post_credit_done_at          := old.post_credit_done_at;
  new.billing_details              := old.billing_details;
  new.dispute_status               := old.dispute_status;
  new.dispute_opened_at            := old.dispute_opened_at;
  new.dispute_resolution           := old.dispute_resolution;
  new.pay_currency                 := old.pay_currency;
  new.pay_amount                   := old.pay_amount;
  new.fx_rate                      := old.fx_rate;
  new.plan_slug                    := old.plan_slug;
  new.refund_requested_at          := old.refund_requested_at;
  new.billing_details_revision     := old.billing_details_revision;
  new.billing_details_updated_at   := old.billing_details_updated_at;
  new.mismatch_alerted_at          := old.mismatch_alerted_at;
  new.dispute_reminded_at          := old.dispute_reminded_at;
  new.tax_rate_pct                 := old.tax_rate_pct;
  new.tax_label                    := old.tax_label;
  new.auto_recharge                := old.auto_recharge;
  new.list_usd                     := old.list_usd;
  new.discount_pct                 := old.discount_pct;

  return new;
end;
$$;
revoke all on function public.protect_order_columns() from public, anon, authenticated;
grant execute on function public.protect_order_columns() to service_role;

-- 4 ───────────────────────────────────────────────────────────────────
do $$
declare
  t      record;
  r      record;
  v_cmd  text;
  v_priv text;
  v_drop text[];
begin
  for t in
    select c.oid, c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  loop
    for r in select rolname, oid as roid from pg_roles where rolname in ('anon', 'authenticated') loop
      v_drop := '{}';
      -- Write privileges with no RLS policy for that command behind them.
      foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE'] loop
        v_cmd := case v_priv when 'INSERT' then 'a' when 'UPDATE' then 'w' else 'd' end;
        if has_table_privilege(r.rolname, t.oid, v_priv)
           and not exists (
             select 1 from pg_policy p
             where p.polrelid = t.oid
               and p.polcmd in (v_cmd, '*')
               and (0 = any (p.polroles) or r.roid = any (p.polroles))
           ) then
          v_drop := v_drop || v_priv;
        end if;
      end loop;
      -- Never needed by a client role, and TRUNCATE is not subject to RLS at all.
      foreach v_priv in array array['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
        if exists (
          select 1 from aclexplode(coalesce((select relacl from pg_class where oid = t.oid), '{}'::aclitem[])) a
          where a.grantee = r.roid and a.privilege_type = v_priv
        ) then
          v_drop := v_drop || v_priv;
        end if;
      end loop;
      if array_length(v_drop, 1) > 0 then
        execute format('revoke %s on public.%I from %I', array_to_string(v_drop, ', '), t.relname, r.rolname);
      end if;
    end loop;
  end loop;
end $$;

revoke all on all sequences in schema public from anon, authenticated;

insert into public.schema_migrations (filename) values
  ('0114_database_layer_closeout_round2.sql')
on conflict do nothing;
