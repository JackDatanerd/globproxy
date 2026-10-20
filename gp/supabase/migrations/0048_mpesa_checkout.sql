-- ============================================================
-- 0048 — M-Pesa checkout (KES via Paystack mobile money)
-- ============================================================
-- Prices stay in USD. An M-Pesa order additionally records the KES amount the
-- customer was asked to pay (pay_amount, whole shillings) and the USD→KES rate
-- it was derived from (fx_rate), both locked when the order is created. Card
-- orders leave pay_amount / fx_rate null and pay_currency 'USD'.
-- Verification, reconcile and refunds compare against / convert by these
-- columns (lib/paystack.ts expectedCharge, webhook refund handler).
--
-- platform_settings keys used by lib/fx.ts:
--   mpesa_enabled      'true' | 'false'  — master switch for the M-Pesa option
--   kes_fx_markup_pct  percent added to the market rate (default 2, max 10)
--   kes_fx_manual      fallback KES-per-USD used only if no live/cached rate
--   kes_fx_cache       JSON {mid, fetched_at, source} written by the app

alter table public.orders add column if not exists pay_currency text not null default 'USD';
alter table public.orders add column if not exists pay_amount numeric;
alter table public.orders add column if not exists fx_rate numeric;

alter table public.orders drop constraint if exists orders_pay_currency_check;
alter table public.orders add constraint orders_pay_currency_check check (pay_currency in ('USD', 'KES'));
alter table public.orders drop constraint if exists orders_pay_amount_check;
alter table public.orders add constraint orders_pay_amount_check
  check ((pay_currency = 'USD' and pay_amount is null) or (pay_currency <> 'USD' and coalesce(pay_amount, 0) > 0 and coalesce(fx_rate, 0) > 0));

insert into public.platform_settings (key, value) values
  ('mpesa_enabled', 'true'),
  ('kes_fx_markup_pct', '2'),
  ('kes_fx_manual', ''),
  ('kes_fx_cache', '')
on conflict (key) do nothing;

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

  new.user_id               := old.user_id;
  new.plan_id               := old.plan_id;
  new.gb_amount             := old.gb_amount;
  new.amount_usd            := old.amount_usd;
  new.payment_method        := old.payment_method;
  new.paystack_reference    := old.paystack_reference;
  new.bandwidth_credited    := old.bandwidth_credited;
  new.paid_at               := old.paid_at;
  new.created_at            := old.created_at;
  new.invoice_number        := old.invoice_number;
  new.failure_reason        := old.failure_reason;
  new.failed_at             := old.failed_at;
  new.is_canary             := old.is_canary;
  new.refunded_usd          := old.refunded_usd;
  new.refunded_at           := old.refunded_at;
  new.reconcile_checked_at  := old.reconcile_checked_at;
  new.post_credit_done_at   := old.post_credit_done_at;
  new.billing_details       := old.billing_details;
  new.dispute_status        := old.dispute_status;
  new.dispute_opened_at     := old.dispute_opened_at;
  new.dispute_resolution    := old.dispute_resolution;
  new.pay_currency          := old.pay_currency;
  new.pay_amount            := old.pay_amount;
  new.fx_rate               := old.fx_rate;

  return new;
end;
$$;

insert into public.schema_migrations (filename) values
  ('0048_mpesa_checkout.sql')
on conflict do nothing;
