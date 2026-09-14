-- ============================================================
-- 0037 — Verified Operators
-- ============================================================
-- A small, hand-picked cohort of already-approved affiliates get a
-- distinguishing flag plus a better rate (40% intro / 20% lifetime vs.
-- the 30%/15% standard default). No new commission-calc logic needed —
-- record_affiliate_commission() (migration 0031) already reads
-- affiliate_commission_rate(_lifetime) per-profile via coalesce(), so
-- setting a custom rate on these five rows is enough on its own; the
-- flag exists only so the UI (admin table + dashboard badge) has
-- something to key off, instead of inferring status from "does this
-- person happen to have a non-default rate."
--
-- Deliberately no application flow, no public form, no per-GB/volume
-- tracking — this is admin-granted only, to a handful of people
-- approached directly. See marketing-plan discussion.
--
-- Safe to run against the live DB: idempotent, purely additive.

alter table public.profiles
  add column if not exists is_verified_operator boolean not null default false;

alter table public.profiles
  add column if not exists verified_operator_since timestamptz;

-- protect_privileged_profile_columns: full body again (CREATE OR REPLACE
-- replaces the whole function), plus the two new columns alongside the
-- affiliate fields it already protects — a non-admin can't grant this
-- to themselves any more than they can approve their own affiliate
-- application.
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
  new.email                              := old.email; -- see migration 0011
  new.affiliate_status                   := old.affiliate_status; -- see migration 0031
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;
  new.payout_method                      := old.payout_method; -- see migration 0034, extended by 0035
  new.payout_wallet_address              := old.payout_wallet_address;
  new.payout_wallet_network              := old.payout_wallet_network;
  new.payout_bank_details                := old.payout_bank_details;
  new.payout_mpesa_phone                 := old.payout_mpesa_phone;
  new.payout_method_updated_at           := old.payout_method_updated_at;
  new.is_verified_operator               := old.is_verified_operator; -- see migration 0037
  new.verified_operator_since            := old.verified_operator_since;

  return new;
end;
$$;

insert into public.schema_migrations (filename) values
  ('0037_verified_operators.sql')
on conflict do nothing;
