-- ============================================================
-- 0076 — Payments & billing close-out (audit section 3, round 4)
-- ============================================================
-- 1. payment_holds: an account that LOST a chargeback can no longer buy until an
--    admin clears the hold (before this only an OPEN dispute paused purchases, so
--    buy -> use -> chargeback could repeat once per lost dispute).
-- 2. orders.dispute_reminded_at: throttles the admin alert for Paystack's
--    charge.dispute.remind (sent every 4 hours while a dispute is unanswered).
-- 3. orders.tax_rate_pct / tax_label: the VAT (or similar) rate in force when the
--    order was placed, frozen onto the order so a later rate change never rewrites
--    an invoice. NULL = no tax line (the default).
-- 4. Auto-recharge: saved_cards (a reusable Paystack authorization the customer
--    agreed to save at checkout) and auto_recharge (their settings). Both are
--    service-role only — the authorization code is a secret — and are read through
--    /api/dashboard/billing/auto-recharge. orders.auto_recharge marks the orders the
--    cron placed.
-- 5. protect_order_columns() pins the new order columns against customer writes.

-- ── orders ──────────────────────────────────────────────────
alter table public.orders add column if not exists dispute_reminded_at timestamptz;
alter table public.orders add column if not exists tax_rate_pct numeric;
alter table public.orders add column if not exists tax_label text;
alter table public.orders add column if not exists auto_recharge boolean not null default false;

alter table public.orders drop constraint if exists orders_tax_rate_check;
alter table public.orders add constraint orders_tax_rate_check
  check (tax_rate_pct is null or (tax_rate_pct >= 0 and tax_rate_pct <= 100));

-- ── payment_holds ───────────────────────────────────────────
create table if not exists public.payment_holds (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  reason     text not null check (char_length(reason) between 3 and 300),
  source     text not null default 'dispute_lost' check (source in ('dispute_lost', 'admin')),
  order_id   uuid references public.orders(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.payment_holds enable row level security;
-- The customer may see that a hold exists (Billing explains it); writes are service role only.
drop policy if exists "Own payment hold" on public.payment_holds;
create policy "Own payment hold" on public.payment_holds for select using (auth.uid() = user_id);

-- ── saved_cards / auto_recharge ─────────────────────────────
create table if not exists public.saved_cards (
  user_id            uuid primary key references public.profiles(id) on delete cascade,
  authorization_code text not null,
  email              text not null,
  brand              text,
  last4              text,
  exp_month          text,
  exp_year           text,
  signature          text,
  consent_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.saved_cards enable row level security; -- no policies: service role only

create table if not exists public.auto_recharge (
  user_id              uuid primary key references public.profiles(id) on delete cascade,
  enabled              boolean not null default false,
  threshold_gb         numeric not null default 5 check (threshold_gb >= 1 and threshold_gb <= 500),
  plan_slug            text not null default 'starter',
  gb                   integer,                     -- only for plan_slug = 'custom'
  monthly_cap_usd      numeric not null default 100 check (monthly_cap_usd >= 1 and monthly_cap_usd <= 5000),
  consecutive_failures integer not null default 0,
  last_attempt_at      timestamptz,
  last_order_id        uuid references public.orders(id) on delete set null,
  disabled_reason      text,
  cap_notified_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
alter table public.auto_recharge enable row level security; -- no policies: service role only
create index if not exists auto_recharge_enabled_idx on public.auto_recharge (last_attempt_at nulls first) where enabled;
create index if not exists orders_auto_recharge_idx on public.orders (user_id, created_at) where auto_recharge;

-- ── protect_order_columns ───────────────────────────────────
create or replace function public.protect_order_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
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

  return new;
end;
$$;

insert into public.schema_migrations (filename) values
  ('0076_payments_billing_pass4.sql')
on conflict do nothing;
