-- ============================================================
-- 0057 — Payments & billing close-out (audit section 3, round 2)
-- ============================================================
-- 1. orders.plan_slug: which plan (or 'custom') an order bought, so invoices
--    and reports can name it. (orders.plan_id points at the unused `plans`
--    table and was never written.)
-- 2. orders.refund_requested_at + claim_refund_request(): an atomic,
--    row-locked "a refund is already in flight" guard for the admin refund
--    route. The old guard read the audit log first and wrote it only after
--    the Paystack call, so two near-simultaneous clicks both passed. The lock
--    is cleared when Paystack reports the refund processed / failed
--    (apply_order_refund below, and the webhook's refund.failed handler) and
--    expires on its own after 24h so a lost event can never strand an order.
-- 3. orders.billing_details_revision / _updated_at + reissue_invoice_details():
--    a customer who forgot their VAT id / address can re-snapshot their CURRENT
--    billing details onto an invoice they were already issued. Capped at 3
--    revisions per invoice, never touches amounts, number or dates, and the
--    invoice page shows that it was revised.
-- 4. protect_order_columns() pins the new columns against customer writes.
-- 5. apply_order_refund() also clears refund_requested_at.

-- ── 1. columns ──────────────────────────────────────────────
alter table public.orders add column if not exists plan_slug text;
alter table public.orders add column if not exists refund_requested_at timestamptz;
alter table public.orders add column if not exists billing_details_revision integer not null default 0;
alter table public.orders add column if not exists billing_details_updated_at timestamptz;

-- ── 4. protect_order_columns ────────────────────────────────
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

  return new;
end;
$$;

-- ── 5. apply_order_refund (0047 body + clears the in-flight lock) ──
create or replace function public.apply_order_refund(
  p_order_id uuid,
  p_refund_reference text,
  p_refund_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order     public.orders%rowtype;
  v_credited  boolean;
  v_refund    numeric;
  v_gb        numeric;
  v_avail     numeric;
  v_claw      numeric;
  v_inserted  text;
  v_total     numeric;
  v_note      text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'order_not_found');
  end if;

  -- Serialised by the order lock above, so a redelivered refund event is a
  -- clean no-op that does not burn a credit-note number.
  if exists (select 1 from public.order_refunds where refund_reference = p_refund_reference) then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  v_credited := v_order.bandwidth_credited is true;
  -- An uncredited order can still have been paid (webhook delayed): refunds
  -- against it are recorded. Anything else uncredited is not a real payment.
  if not v_credited and v_order.payment_status not in ('pending', 'cancelled', 'failed') then
    return jsonb_build_object('applied', false, 'reason', 'order_never_credited');
  end if;

  v_refund := least(p_refund_usd, v_order.amount_usd - v_order.refunded_usd);
  if v_refund is null or v_refund <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'nothing_to_refund');
  end if;

  if v_credited then
    v_gb := round(v_order.gb_amount * v_refund / v_order.amount_usd, 6);
    select available_gb into v_avail
    from public.bandwidth_accounts where user_id = v_order.user_id for update;
    v_claw := least(v_gb, greatest(coalesce(v_avail, 0), 0));
  else
    v_gb := 0;
    v_claw := 0;
  end if;

  v_note := 'CN-' || to_char(now() at time zone 'UTC', 'YYYY')
            || '-' || lpad(nextval('public.credit_note_seq')::text, 6, '0');

  insert into public.order_refunds (refund_reference, order_id, amount_usd, gb_clawed, gb_shortfall, credit_note_number)
  values (p_refund_reference, p_order_id, v_refund, v_claw, v_gb - v_claw, v_note)
  on conflict (refund_reference) do nothing
  returning refund_reference into v_inserted;

  if v_inserted is null then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  if v_claw > 0 then
    update public.bandwidth_accounts
    set total_gb = total_gb - v_claw
    where user_id = v_order.user_id;
  end if;

  v_total := v_order.refunded_usd + v_refund;
  update public.orders
  set refunded_usd         = v_total,
      refunded_at          = now(),
      refund_requested_at  = null,
      payment_status       = case when v_total >= amount_usd then 'refunded' else payment_status end
  where id = p_order_id;

  return jsonb_build_object(
    'applied', true,
    'credited', v_credited,
    'refund_usd', v_refund,
    'gb_clawed', v_claw,
    'gb_shortfall', v_gb - v_claw,
    'fully_refunded', v_total >= v_order.amount_usd,
    'credit_note', v_note
  );
end;
$$;

-- ── 2. claim_refund_request ─────────────────────────────────
-- true  = caller now owns the right to send ONE refund request for this order
-- false = one is already in flight (requested within the last 24h and Paystack
--         has not yet reported it processed or failed) or the order is gone.
create or replace function public.claim_refund_request(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
begin
  select refund_requested_at into v_at from public.orders where id = p_order_id for update;
  if not found then
    return false;
  end if;
  if v_at is not null and v_at > now() - interval '24 hours' then
    return false;
  end if;
  update public.orders set refund_requested_at = now() where id = p_order_id;
  return true;
end;
$$;

-- ── 3. reissue_invoice_details ──────────────────────────────
create or replace function public.reissue_invoice_details(p_order_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order  public.orders%rowtype;
  v_new    jsonb;
  c_max    constant integer := 3;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_order.is_canary or v_order.invoice_number is null or v_order.payment_status not in ('paid', 'refunded') then
    return jsonb_build_object('ok', false, 'reason', 'no_invoice');
  end if;

  select jsonb_strip_nulls(jsonb_build_object(
    'name',    coalesce(nullif(btrim(pr.company_name), ''), nullif(btrim(pr.full_name), '')),
    'contact', nullif(btrim(pr.full_name), ''),
    'email',   pr.email,
    'address', nullif(btrim(pr.billing_address), ''),
    'tax_id',  nullif(btrim(pr.tax_id), '')
  )) into v_new
  from public.profiles pr where pr.id = p_user_id;

  if v_new is null then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;
  if v_order.billing_details is not null and v_order.billing_details = v_new then
    return jsonb_build_object('ok', true, 'unchanged', true, 'revision', v_order.billing_details_revision);
  end if;
  if v_order.billing_details_revision >= c_max then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached', 'limit', c_max);
  end if;

  update public.orders
  set billing_details            = v_new,
      billing_details_revision   = billing_details_revision + 1,
      billing_details_updated_at = now()
  where id = p_order_id;

  return jsonb_build_object('ok', true, 'unchanged', false, 'revision', v_order.billing_details_revision + 1, 'limit', c_max);
end;
$$;

-- Same posture as 0042/0047: service role only.
revoke all on function public.claim_refund_request(uuid) from public, anon, authenticated;
grant execute on function public.claim_refund_request(uuid) to service_role;
revoke all on function public.reissue_invoice_details(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reissue_invoice_details(uuid, uuid) to service_role;
revoke all on function public.apply_order_refund(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.apply_order_refund(uuid, text, numeric) to service_role;

insert into public.schema_migrations (filename) values
  ('0057_payments_billing_pass2.sql')
on conflict do nothing;
