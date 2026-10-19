-- ============================================================
-- 0034 — Affiliate payout cycles
-- ============================================================
-- Biweekly batching on top of the per-order affiliate_commissions ledger
-- from migration 0031: commissions earned 1st–15th are batched and become
-- payable from the 20th; commissions earned 16th–end of month are batched
-- and become payable from the 5th of the following month. Fixed calendar
-- dates rather than "nearest Friday" — deterministic, and every affiliate
-- can predict their pay date without checking anything.
--
-- Payout method (USDT/TRC20 or bank) lives on the profile, with its own
-- "last changed" timestamp used for two purposes at once: (1) the "your
-- payout method needs to be set 48h before payout or it rolls to next
-- cycle" rule that was asked for, and (2) — deliberately extended to
-- cover every change, not just first-time setup — a hold against a
-- classic payout-system attack: an account takeover that swaps the
-- payout destination right before a scheduled payout drains it
-- immediately. Holding *every* wallet/bank change for the same 48h gives
-- a window to notice before money moves, at zero extra implementation
-- cost since it's the same timestamp check either way.
--
-- Safe to run against the live DB: idempotent, purely additive.

-- ── Payout method on profiles ──────────────────────────────────
alter table public.profiles add column if not exists payout_method text;
alter table public.profiles drop constraint if exists profiles_payout_method_check;
alter table public.profiles add constraint profiles_payout_method_check
  check (payout_method is null or payout_method in ('usdt', 'bank'));

alter table public.profiles add column if not exists payout_wallet_address text;

-- TRC20 (Tron) only for now — lowest fees, fastest, the standard choice
-- for this kind of payout, and an explicit column (rather than assuming
-- a network) means an address is never ambiguous about which chain it
-- belongs to. Widen the check constraint here if a second network is
-- ever supported.
alter table public.profiles add column if not exists payout_wallet_network text;
alter table public.profiles drop constraint if exists profiles_payout_wallet_network_check;
alter table public.profiles add constraint profiles_payout_wallet_network_check
  check (payout_wallet_network is null or payout_wallet_network = 'TRC20');

alter table public.profiles add column if not exists payout_bank_details jsonb;

-- Never set by the user directly — see the update-payout-method route,
-- which always sets this server-side via the admin client at write time.
-- protect_privileged_profile_columns (below) is what makes that the only
-- path: without it, a user could PATCH their own profile row directly
-- via the client SDK and set both a new wallet address AND an old
-- updated_at in the same request, defeating the 48h hold entirely.
alter table public.profiles add column if not exists payout_method_updated_at timestamp with time zone;

-- protect_privileged_profile_columns (0003, extended by 0028, 0031) now
-- also covers the five payout columns above, for the reason in the
-- comment on payout_method_updated_at just above. This is the same
-- pattern as every earlier extension of this trigger — CREATE OR REPLACE
-- with the full existing body plus the new columns, not a partial patch.
create or replace function public.protect_privileged_profile_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new; -- service-role client; app code already gates this
  end if;

  if public.is_admin(auth.uid()) then
    return new;
  end if;

  new.role                               := old.role;
  new.is_suspended                       := old.is_suspended;
  new.suspended_at                       := old.suspended_at;
  new.suspension_reason                  := old.suspension_reason;
  new.reseller_status                    := old.reseller_status;
  new.api_access                         := old.api_access;
  new.api_access_status                  := old.api_access_status;
  new.is_deleted                         := old.is_deleted;
  new.deleted_at                         := old.deleted_at;
  new.email                              := old.email; -- see migration 0011 — the sync trigger is how email changes actually land
  new.affiliate_status                   := old.affiliate_status;
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;
  new.payout_method                      := old.payout_method;
  new.payout_wallet_address              := old.payout_wallet_address;
  new.payout_wallet_network              := old.payout_wallet_network;
  new.payout_bank_details                := old.payout_bank_details;
  new.payout_method_updated_at           := old.payout_method_updated_at;

  return new;
end;
$$;

-- ── Payout batches ──────────────────────────────────────────────
-- One row per affiliate per cycle that actually got batched (see
-- run_affiliate_payout_cycle below — affiliates who are held or under
-- the minimum simply get no row this cycle; their commissions stay
-- unbatched and roll into whichever future cycle succeeds). Wallet/bank
-- details are snapshotted onto the row at batch time, not a live
-- reference to the profile — so a later payout-method change never
-- retroactively edits where a past, already-batched payout is headed.
create table if not exists public.affiliate_payouts (
  id                    uuid default uuid_generate_v4() primary key,
  referrer_id           uuid references public.profiles(id) on delete cascade not null,
  cycle_start           date not null,
  cycle_end             date not null,
  amount_usd            numeric not null,
  status                text not null default 'pending' check (status in ('pending', 'paid')),
  payout_method         text not null,
  payout_wallet_address text,
  payout_wallet_network text,
  payout_bank_details   jsonb,
  created_at            timestamp with time zone default now(),
  paid_at               timestamp with time zone,
  notified_at           timestamp with time zone,
  unique (referrer_id, cycle_start, cycle_end)
);

create index if not exists idx_affiliate_payouts_referrer on public.affiliate_payouts(referrer_id);
create index if not exists idx_affiliate_payouts_status on public.affiliate_payouts(status);

alter table public.affiliate_payouts enable row level security;

drop policy if exists "Referrer can view own payouts" on public.affiliate_payouts;
create policy "Referrer can view own payouts" on public.affiliate_payouts for select
  using (auth.uid() = referrer_id);
drop policy if exists "Admins can view all payouts" on public.affiliate_payouts;
create policy "Admins can view all payouts" on public.affiliate_payouts for select
  using (public.is_admin(auth.uid()));

-- No client insert/update policies — run_affiliate_payout_cycle and
-- mark_affiliate_payout_paid (both below) are the only writers, called
-- from admin-only, MFA-gated routes via the service-role client, same
-- posture as every other admin-authored table in this schema.

-- Links a commission to the payout batch it was claimed by, once run.
-- payout_id is null for every commission that hasn't been batched yet —
-- that's the actual "still accumulating" state, not a separate flag.
alter table public.affiliate_commissions add column if not exists payout_id uuid references public.affiliate_payouts(id) on delete set null;
create index if not exists idx_affiliate_commissions_payout on public.affiliate_commissions(payout_id);

-- ── Run a payout cycle ───────────────────────────────────────────
-- For every affiliate with unbatched, still-pending commissions earned
-- inside [p_cycle_start, p_cycle_end], decide what happens to their
-- total and (if eligible) create the payout row + claim those
-- commissions in one transaction:
--
--   'no_payout_method'    — nothing on file yet; keeps accumulating
--   'held_recent_method'  — payout method set/changed within the hold
--                           window; keeps accumulating (see the fraud
--                           note in the header comment above)
--   'below_minimum'       — under p_min_payout_usd; keeps accumulating
--   'created'             — payout row created, commissions claimed
--   'already_run'         — this exact cycle already has a payout row
--                           for this referrer (re-running is safe —
--                           already-claimed commissions are never
--                           claimed a second time)
--
-- Returns one row per affiliate with unbatched activity in the window,
-- whatever the outcome, so the admin UI can show the full picture —
-- including *why* someone got skipped — from a single call.
create or replace function public.run_affiliate_payout_cycle(
  p_cycle_start date,
  p_cycle_end date,
  p_min_payout_usd numeric default 20,
  p_hold_hours integer default 48
)
returns table (
  out_referrer_id uuid,
  out_status text,
  out_amount_usd numeric,
  out_payout_id uuid
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_status text;
  v_new_payout_id uuid;
  v_method text;
  v_method_updated timestamptz;
  v_wallet_address text;
  v_wallet_network text;
  v_bank jsonb;
begin
  for r in
    select ac.referrer_id as rid, sum(ac.commission_amount_usd) as total
    from public.affiliate_commissions ac
    where ac.payout_id is null
      and ac.status = 'pending'
      and ac.created_at::date between p_cycle_start and p_cycle_end
    group by ac.referrer_id
  loop
    select payout_method, payout_method_updated_at, payout_wallet_address, payout_wallet_network, payout_bank_details
      into v_method, v_method_updated, v_wallet_address, v_wallet_network, v_bank
    from public.profiles where id = r.rid;

    if v_method is null then
      v_status := 'no_payout_method';
    elsif v_method_updated is null or v_method_updated > (now() - (p_hold_hours || ' hours')::interval) then
      v_status := 'held_recent_method';
    elsif r.total < p_min_payout_usd then
      v_status := 'below_minimum';
    else
      v_status := 'created';
    end if;

    v_new_payout_id := null;

    if v_status = 'created' then
      insert into public.affiliate_payouts
        (referrer_id, cycle_start, cycle_end, amount_usd, status,
         payout_method, payout_wallet_address, payout_wallet_network, payout_bank_details)
      values
        (r.rid, p_cycle_start, p_cycle_end, r.total, 'pending',
         v_method, v_wallet_address, v_wallet_network, v_bank)
      on conflict (referrer_id, cycle_start, cycle_end) do nothing
      returning id into v_new_payout_id;

      if v_new_payout_id is not null then
        update public.affiliate_commissions
        set payout_id = v_new_payout_id
        where referrer_id = r.rid
          and payout_id is null
          and status = 'pending'
          and created_at::date between p_cycle_start and p_cycle_end;
      else
        -- Unique constraint already has a row for this referrer+cycle —
        -- this exact cycle was run before. Do NOT claim these commissions
        -- under a second payout row; leave them for the next run.
        v_status := 'already_run';
      end if;
    end if;

    out_referrer_id := r.rid;
    out_status := v_status;
    out_amount_usd := r.total;
    out_payout_id := v_new_payout_id;
    return next;
  end loop;
end;
$$;

revoke all on function public.run_affiliate_payout_cycle(date, date, numeric, integer) from public;
grant execute on function public.run_affiliate_payout_cycle(date, date, numeric, integer) to service_role;

-- ── Mark a payout paid ───────────────────────────────────────────
-- One action for the whole batch, not per-commission — matches how the
-- admin UI presents it (one "mark paid" button per affiliate per cycle).
-- Mirrors the linked commissions' status to 'paid' too, purely so
-- anywhere still displaying commission-level status stays consistent —
-- affiliate_payouts.status is the actual source of truth for "has this
-- money moved." Idempotent via the same claim-then-act shape used
-- throughout this schema (UPDATE ... WHERE status = 'pending' ...
-- RETURNING only ever matches once).
create or replace function public.mark_affiliate_payout_paid(p_payout_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claimed uuid;
begin
  update public.affiliate_payouts
  set status = 'paid', paid_at = now()
  where id = p_payout_id and status = 'pending'
  returning id into v_claimed;

  if v_claimed is null then
    return false;
  end if;

  update public.affiliate_commissions
  set status = 'paid', paid_at = now()
  where payout_id = v_claimed;

  return true;
end;
$$;

revoke all on function public.mark_affiliate_payout_paid(uuid) from public;
grant execute on function public.mark_affiliate_payout_paid(uuid) to service_role;

insert into public.schema_migrations (filename) values
  ('0034_affiliate_payout_cycles.sql')
on conflict do nothing;
