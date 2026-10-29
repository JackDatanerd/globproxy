-- 0107 — M-Pesa launch offer: record the discount on the order.
--
-- The offer itself lives in platform_settings ('mpesa_promo', one JSON value edited from
-- Admin → Settings → "M-Pesa offer"), so no table is needed for it. What the ORDER needs is a
-- record of what was taken off: orders.amount_usd stays "what the customer was charged" (the
-- discounted total — the figure Paystack verification, invoices, refunds and affiliate
-- commissions all read), and these two columns keep the price before the offer and the percent
-- applied, so the invoice can show the discount and support can see it.
--
-- NULL on every order placed without an offer (all existing orders, and every card order).
-- The columns are pinned against customer writes like the other price columns.
-- Idempotent.
alter table public.orders add column if not exists list_usd numeric
  check (list_usd is null or list_usd > 0);
alter table public.orders add column if not exists discount_pct numeric
  check (discount_pct is null or (discount_pct > 0 and discount_pct <= 100));

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
  new.list_usd                     := old.list_usd;
  new.discount_pct                 := old.discount_pct;

  return new;
end;
$$;

insert into public.schema_migrations (filename) values
  ('0107_mpesa_promo.sql')
on conflict do nothing;
