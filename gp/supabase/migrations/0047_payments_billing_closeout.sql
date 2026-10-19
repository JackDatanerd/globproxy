-- ============================================================
-- 0047 — Payments & billing close-out (audit pass 1)
-- ============================================================
-- 1. Refund-before-credit race. A Paystack refund.processed that arrived
--    while the order was still uncredited (webhook for the charge delayed or
--    retrying) used to be rejected ('order_never_credited'), the webhook
--    answered 200, and the refund was lost for good — the later
--    charge.success then credited the FULL bandwidth for a payment that had
--    already been refunded. apply_order_refund() now records a refund
--    against an uncredited order (no GB to claw back; fully refunded →
--    'refunded', which claim_and_credit_order() never claims), and
--    claim_and_credit_order() credits only the un-refunded share of an
--    order that was partially refunded before it was credited.
-- 2. Credit notes: every refund gets a sequential CN-YYYY-NNNNNN number and
--    the customer can read their own refund rows (invoice page).
-- 3. Invoice buyer details: profiles.billing_address / tax_id, snapshotted
--    onto orders.billing_details at the moment the order is claimed as paid,
--    so editing your address later never rewrites old invoices.
-- 4. Disputes: orders.dispute_status / dispute_opened_at / dispute_resolution
--    (written by the Paystack webhook; checkout is paused while one is open).
-- 5. protect_order_columns() pins the new order columns against customer
--    writes.

-- ── 1/4. orders columns ─────────────────────────────────────
alter table public.orders add column if not exists billing_details jsonb;
alter table public.orders add column if not exists dispute_status text;
alter table public.orders add column if not exists dispute_opened_at timestamptz;
alter table public.orders add column if not exists dispute_resolution text;

alter table public.orders drop constraint if exists orders_dispute_status_check;
alter table public.orders add constraint orders_dispute_status_check
  check (dispute_status is null or dispute_status in ('open', 'resolved'));

create index if not exists orders_open_dispute_idx
  on public.orders (user_id) where dispute_status = 'open';

-- ── 3. profiles billing details ─────────────────────────────
alter table public.profiles add column if not exists billing_address text;
alter table public.profiles add column if not exists tax_id text;

alter table public.profiles drop constraint if exists profiles_billing_details_len;
alter table public.profiles add constraint profiles_billing_details_len
  check (char_length(coalesce(billing_address, '')) <= 500 and char_length(coalesce(tax_id, '')) <= 64);

-- ── 2. credit notes ─────────────────────────────────────────
create sequence if not exists public.credit_note_seq;
revoke all on sequence public.credit_note_seq from public, anon, authenticated;

alter table public.order_refunds add column if not exists credit_note_number text;

-- Backfill existing refunds oldest-first.
do $$
declare r record;
begin
  for r in
    select refund_reference, created_at from public.order_refunds
    where credit_note_number is null
    order by created_at, refund_reference
  loop
    update public.order_refunds
    set credit_note_number = 'CN-' || to_char(r.created_at at time zone 'UTC', 'YYYY')
                             || '-' || lpad(nextval('public.credit_note_seq')::text, 6, '0')
    where refund_reference = r.refund_reference;
  end loop;
end $$;

create unique index if not exists order_refunds_credit_note_key
  on public.order_refunds (credit_note_number) where credit_note_number is not null;

-- Customers may read refund rows of their own orders (invoice page). Writes
-- remain service-role only (no insert/update/delete policy).
drop policy if exists "Own order refunds" on public.order_refunds;
create policy "Own order refunds" on public.order_refunds for select
  using (exists (select 1 from public.orders o where o.id = order_refunds.order_id and o.user_id = auth.uid()));

-- ── 1/3. claim_and_credit_order ─────────────────────────────
create or replace function public.claim_and_credit_order(
  p_order_id uuid,
  p_user_id uuid,
  p_gb numeric,
  p_paystack_reference text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed  uuid;
  v_amount   numeric;
  v_refunded numeric;
  v_credit   numeric;
begin
  update public.orders
  set payment_status     = 'paid',
      paystack_reference = p_paystack_reference,
      bandwidth_credited = true,
      paid_at            = now(),
      failure_reason     = null,
      failed_at          = null,
      invoice_number     = case
        when is_canary then null
        else 'INV-' || to_char(now() at time zone 'UTC', 'YYYY')
             || '-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0')
      end,
      -- Buyer details as they are today, frozen onto the invoice.
      billing_details    = (
        select jsonb_strip_nulls(jsonb_build_object(
          'name',    coalesce(nullif(btrim(pr.company_name), ''), nullif(btrim(pr.full_name), '')),
          'contact', nullif(btrim(pr.full_name), ''),
          'email',   pr.email,
          'address', nullif(btrim(pr.billing_address), ''),
          'tax_id',  nullif(btrim(pr.tax_id), '')
        ))
        from public.profiles pr where pr.id = p_user_id
      )
  where id = p_order_id
    and user_id = p_user_id
    and bandwidth_credited = false
    and payment_status in ('pending', 'cancelled', 'failed')
  returning id, amount_usd, coalesce(refunded_usd, 0) into v_claimed, v_amount, v_refunded;

  if v_claimed is null then
    return false; -- already credited, refunded, or not this user's order
  end if;

  -- A refund that landed before this credit (see apply_order_refund) already
  -- gave that share of the money back: credit only what is still paid for.
  v_credit := case
    when v_refunded > 0 and v_amount > 0
      then round(p_gb * greatest(v_amount - v_refunded, 0) / v_amount, 6)
    else p_gb
  end;

  if v_credit > 0 then
    perform public.credit_bandwidth(p_user_id, v_credit); -- uncaught error rolls the claim back too
  end if;

  return true;
end;
$$;

-- ── 1/2. apply_order_refund ─────────────────────────────────
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
  set refunded_usd   = v_total,
      refunded_at    = now(),
      payment_status = case when v_total >= amount_usd then 'refunded' else payment_status end
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

-- ── 5. protect_order_columns ────────────────────────────────
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

  return new;
end;
$$;

-- The functions above were re-created; default privileges already keep new
-- SECURITY DEFINER functions off anon/authenticated (0042), restated here so
-- this migration is self-evidently safe on its own.
revoke all on function public.claim_and_credit_order(uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.claim_and_credit_order(uuid, uuid, numeric, text) to service_role;
revoke all on function public.apply_order_refund(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.apply_order_refund(uuid, text, numeric) to service_role;

insert into public.schema_migrations (filename) values
  ('0047_payments_billing_closeout.sql')
on conflict do nothing;
