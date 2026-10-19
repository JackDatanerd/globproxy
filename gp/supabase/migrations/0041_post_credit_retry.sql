-- ============================================================
-- 0041 — Payments: retriable post-credit steps
-- ============================================================
-- After claim_and_credit_order() commits, activateBandwidth() runs the
-- follow-ups: provisioning pending credentials at Geonode and crediting the
-- referral bonus / affiliate commission. They ran exactly once and were
-- never retried, so a Geonode or DB hiccup at that moment meant a referrer
-- was never paid or a credential never provisioned, with nothing to notice.
--
-- orders.post_credit_done_at is stamped when those steps succeed. The
-- reconcile cron re-runs them (they are idempotent) for credited orders
-- that are still unstamped, for up to 3 days.
--
-- Orders credited before this migration are backfilled as done so the first
-- cron run doesn't re-process history.

alter table public.orders add column if not exists post_credit_done_at timestamptz;

update public.orders
set post_credit_done_at = coalesce(paid_at, now())
where bandwidth_credited = true and post_credit_done_at is null;

create index if not exists orders_post_credit_pending_idx
  on public.orders (paid_at)
  where bandwidth_credited = true and post_credit_done_at is null;

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

  return new;
end;
$$;

insert into public.schema_migrations (filename) values
  ('0041_post_credit_retry.sql')
on conflict do nothing;
