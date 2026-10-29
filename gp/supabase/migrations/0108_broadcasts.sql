-- 0108 — Broadcasts: message all (or selected) customers by e-mail and/or a dashboard banner.
--
--  * profiles.marketing_emails — the customer's opt-out for product news & offers. Default ON (existing
--    customers keep hearing about new features; every such e-mail carries a one-click unsubscribe).
--    Receipts, security notices and "service" broadcasts (outages, policy changes) ignore it.
--  * broadcasts            — one row per message an admin sends.
--  * broadcast_recipients  — one row per account the message was addressed to (a snapshot of the audience
--                            when "Send" was pressed). Holds NO e-mail address: the address is read from
--                            the profile at the moment of sending, so an address changed or an account
--                            deleted since is honoured, and no copy of it outlives the account.
--  * broadcast_user_ok / broadcast_audience / broadcast_preview / broadcast_enqueue / broadcast_claim —
--    the single definition of "who may be messaged" (not deleted, not suspended, no deletion scheduled,
--    not banned, address confirmed) used at preview, at enqueue AND again at send time.
--
-- All new objects are service-role only (RLS on, no policies; functions not executable by browser roles).
-- Idempotent.

alter table public.profiles
  add column if not exists marketing_emails boolean not null default true;

-- profiles is column-granted (migration 0101): a new column is invisible to the signed-in customer until
-- granted, and the Settings toggle reads it with the customer's own token. Writing it needs nothing more —
-- "Update own profile" covers it, and protect_privileged_profile_columns pins only the privileged columns.
grant select (marketing_emails) on public.profiles to authenticated;

create table if not exists public.broadcasts (
  id             uuid primary key default uuid_generate_v4(),
  -- Chosen by the admin's browser per "Send" press: a double click or a retry after a dropped answer
  -- finds the existing row instead of messaging everyone twice.
  request_id     uuid not null unique,
  kind           text not null check (kind in ('marketing','service')),
  subject        text not null check (char_length(subject) between 1 and 150),
  body           text not null check (char_length(body) between 1 and 5000),
  cta_label      text check (cta_label is null or char_length(cta_label) between 1 and 40),
  cta_url        text check (cta_url is null or cta_url ~ '^https://'),
  audience       jsonb not null,
  send_email     boolean not null default true,
  show_banner    boolean not null default false,
  banner_ends_at timestamptz,
  status         text not null default 'sending' check (status in ('sending','done','cancelled')),
  recipient_count integer not null default 0,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz,
  cancelled_at   timestamptz,
  check (not show_banner or banner_ends_at is not null)
);
create index if not exists broadcasts_status_idx on public.broadcasts (status, created_at) where status = 'sending';
create index if not exists broadcasts_banner_idx on public.broadcasts (banner_ends_at) where show_banner;

create table if not exists public.broadcast_recipients (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  reason       text,
  attempts     integer not null default 0,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  primary key (broadcast_id, user_id)
);
create index if not exists broadcast_recipients_status_idx on public.broadcast_recipients (broadcast_id, status);
create index if not exists broadcast_recipients_user_idx on public.broadcast_recipients (user_id);

alter table public.broadcasts enable row level security;
alter table public.broadcast_recipients enable row level security;
revoke all on public.broadcasts from anon, authenticated;
revoke all on public.broadcast_recipients from anon, authenticated;

-- ── who may be messaged ──────────────────────────────────────
create or replace function public.broadcast_user_ok(p_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_id
       and p.is_deleted is not true
       and p.is_suspended is not true
       and p.deletion_scheduled_at is null
       and p.email is not null and left(p.email, 1) <> '['          -- deleted-account tombstones
       and not exists (select 1 from public.banned_emails b where lower(b.email) = lower(p.email))
       and exists (select 1 from auth.users u where u.id = p.id and u.email_confirmed_at is not null)
  );
$$;

-- The accounts an audience resolves to. Audience shapes (validated by the app as well):
--   {"kind":"all"} | {"kind":"role","role":"user"|"reseller"} | {"kind":"buyers"} | {"kind":"never_bought"}
--   {"kind":"selected","emails":["a@x.com", ...]}
create or replace function public.broadcast_audience(p_audience jsonb)
returns table (user_id uuid) language sql stable security definer set search_path = public, pg_temp as $$
  select p.id
    from public.profiles p
   where public.broadcast_user_ok(p.id)
     and case coalesce(p_audience->>'kind', '')
           when 'all'          then true
           when 'role'         then p.role = p_audience->>'role'
           when 'buyers'       then exists (select 1 from public.orders o
                                             where o.user_id = p.id and o.payment_status = 'paid' and not o.is_canary)
           when 'never_bought' then not exists (select 1 from public.orders o
                                                 where o.user_id = p.id and o.payment_status = 'paid' and not o.is_canary)
           when 'selected'     then lower(p.email) in (select lower(e) from jsonb_array_elements_text(p_audience->'emails') e)
           else false
         end;
$$;

-- What pressing "Send" would do, for the confirmation step: how many accounts, how many of them will
-- actually get an e-mail (marketing respects the opt-out), and which listed addresses matched no
-- messageable account (a typo, an unconfirmed or banned address).
create or replace function public.broadcast_preview(p_audience jsonb, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_eligible integer; v_emailable integer; v_unmatched jsonb := '[]'::jsonb;
begin
  select count(*), count(*) filter (where p_kind = 'service' or p.marketing_emails)
    into v_eligible, v_emailable
    from public.broadcast_audience(p_audience) a join public.profiles p on p.id = a.user_id;
  if p_audience->>'kind' = 'selected' then
    select coalesce(jsonb_agg(l.e order by l.e), '[]'::jsonb) into v_unmatched
      from (select distinct lower(e) as e from jsonb_array_elements_text(p_audience->'emails') e) l
     where not exists (select 1 from public.broadcast_audience(p_audience) a
                         join public.profiles p on p.id = a.user_id where lower(p.email) = l.e);
  end if;
  return jsonb_build_object('eligible', v_eligible, 'emailable', v_emailable, 'unmatched', v_unmatched);
end $$;

-- Snapshots the audience into broadcast_recipients. Idempotent: a broadcast that already has recipients
-- is left alone (the cron re-runs this for any broadcast whose first attempt was interrupted).
create or replace function public.broadcast_enqueue(p_broadcast uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_aud jsonb; v_send boolean; v_kind text; n integer;
begin
  select audience, send_email, kind into v_aud, v_send, v_kind
    from public.broadcasts where id = p_broadcast and status = 'sending' for update;
  if not found then return 0; end if;
  if exists (select 1 from public.broadcast_recipients where broadcast_id = p_broadcast) then
    return (select count(*) from public.broadcast_recipients where broadcast_id = p_broadcast);
  end if;

  insert into public.broadcast_recipients (broadcast_id, user_id, status, reason)
  select p_broadcast, p.id,
         case when v_send and (v_kind = 'service' or p.marketing_emails) then 'pending' else 'skipped' end,
         case when not v_send then 'no_email'
              when v_kind <> 'service' and not p.marketing_emails then 'opted_out' end
    from public.broadcast_audience(v_aud) a join public.profiles p on p.id = a.user_id;
  get diagnostics n = row_count;

  update public.broadcasts set recipient_count = n where id = p_broadcast;
  if not exists (select 1 from public.broadcast_recipients where broadcast_id = p_broadcast and status = 'pending') then
    update public.broadcasts set status = 'done', finished_at = now() where id = p_broadcast;
  end if;
  return n;
end $$;

-- Hands the sender its next batch. Everyone returned is marked 'sending'. People who stopped being
-- messageable (or opted out) since the audience was snapshotted are marked 'skipped' instead, so the
-- check is made at the moment of sending, not days earlier. A claim left 'sending' for 15 minutes means a
-- worker died mid-send: it may or may not have gone out, so it is marked 'failed' (never silently
-- re-sent) and an admin decides whether to retry.
create or replace function public.broadcast_claim(p_broadcast uuid, p_limit integer)
returns table (user_id uuid, email text, full_name text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_kind text; v_status text;
begin
  select kind, status into v_kind, v_status from public.broadcasts where id = p_broadcast;
  if v_status is distinct from 'sending' then return; end if;

  update public.broadcast_recipients r
     set status = 'failed', reason = 'interrupted: delivery unconfirmed'
   where r.broadcast_id = p_broadcast and r.status = 'sending' and r.claimed_at < now() - interval '15 minutes';

  return query
  with picked as (
    select r.user_id from public.broadcast_recipients r
     where r.broadcast_id = p_broadcast and r.status = 'pending'
     order by r.user_id limit greatest(p_limit, 0) for update skip locked
  ), judged as (
    select pk.user_id, p.email, p.full_name,
           public.broadcast_user_ok(pk.user_id) as ok_account,
           (v_kind = 'service' or coalesce(p.marketing_emails, false)) as ok_consent
      from picked pk left join public.profiles p on p.id = pk.user_id
  ), marked as (
    update public.broadcast_recipients r
       set status = case when j.ok_account and j.ok_consent then 'sending' else 'skipped' end,
           reason = case when not j.ok_account then 'no_longer_eligible' when not j.ok_consent then 'opted_out' end,
           claimed_at = now(), attempts = r.attempts + 1
      from judged j
     where r.broadcast_id = p_broadcast and r.user_id = j.user_id
    returning r.user_id, r.status
  )
  select j.user_id, j.email, j.full_name
    from judged j join marked m on m.user_id = j.user_id and m.status = 'sending';

  -- Nothing left to send or in flight: the broadcast is finished.
  if not exists (select 1 from public.broadcast_recipients
                  where broadcast_id = p_broadcast and status in ('pending','sending')) then
    update public.broadcasts set status = 'done', finished_at = coalesce(finished_at, now())
     where id = p_broadcast and status = 'sending';
  end if;
end $$;

-- Per-broadcast counts for the admin list.
create or replace function public.broadcast_progress(p_ids uuid[])
returns table (broadcast_id uuid, status text, n bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.broadcast_id, r.status, count(*) from public.broadcast_recipients r
   where r.broadcast_id = any(p_ids) group by r.broadcast_id, r.status;
$$;

revoke all on function public.broadcast_user_ok(uuid) from public, anon, authenticated;
revoke all on function public.broadcast_audience(jsonb) from public, anon, authenticated;
revoke all on function public.broadcast_preview(jsonb, text) from public, anon, authenticated;
revoke all on function public.broadcast_enqueue(uuid) from public, anon, authenticated;
revoke all on function public.broadcast_claim(uuid, integer) from public, anon, authenticated;
revoke all on function public.broadcast_progress(uuid[]) from public, anon, authenticated;
grant execute on function public.broadcast_user_ok(uuid) to service_role;
grant execute on function public.broadcast_audience(jsonb) to service_role;
grant execute on function public.broadcast_preview(jsonb, text) to service_role;
grant execute on function public.broadcast_enqueue(uuid) to service_role;
grant execute on function public.broadcast_claim(uuid, integer) to service_role;
grant execute on function public.broadcast_progress(uuid[]) to service_role;

insert into public.schema_migrations (filename) values
  ('0108_broadcasts.sql')
on conflict do nothing;
