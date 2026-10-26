-- 0096: Payments & billing pass 7 — gap-free credit-note numbers.
--
-- Invoice numbers became gap-free in 0093 (a counter updated inside the claiming
-- transaction), but credit notes still drew from public.credit_note_seq inside
-- apply_order_refund. nextval is never rolled back, so any error after the number was
-- taken (the ledger insert, the bandwidth claw-back) burned it and left a hole in the
-- CN-YYYY-###### series — the same audit question 0093 closed for invoices.
--
-- next_credit_note_number() takes the next value from a one-row counter updated in the
-- caller's transaction: a rollback releases it, concurrent refunds queue on the row lock.
-- Numbering continues from the highest number already issued, so nothing existing changes.
-- apply_order_refund below is the 0065 body with only the number source changed (and the
-- number handed back on the lost-race path).

create table if not exists public.credit_note_counter (
  id        boolean primary key default true check (id),
  last_n    bigint not null default 0
);
alter table public.credit_note_counter enable row level security;
revoke all on public.credit_note_counter from public, anon, authenticated;

insert into public.credit_note_counter (id, last_n)
select true, greatest(
  coalesce((select max(substring(credit_note_number from '^CN-\d{4}-(\d+)$')::bigint)
              from public.order_refunds where credit_note_number ~ '^CN-\d{4}-\d+$'), 0),
  coalesce((select case when is_called then last_value else 0 end from public.credit_note_seq), 0)
)
on conflict (id) do nothing;

create or replace function public.next_credit_note_number()
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.credit_note_counter set last_n = last_n + 1 where id returning last_n;
$$;

revoke all on function public.next_credit_note_number() from public, anon, authenticated;
grant execute on function public.next_credit_note_number() to service_role;

create or replace function public.apply_order_refund(
  p_order_id uuid,
  p_refund_reference text,
  p_refund_usd numeric,
  p_charged_amount numeric default null,
  p_charged_currency text default null,
  p_source text default 'refund'
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
  v_charged   numeric;
  v_source    text := case when p_source = 'dispute' then 'dispute' else 'refund' end;
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

  -- What was refunded in the customer's own currency, for the credit note. A
  -- refund capped above (it asked for more than was left) is scaled down with it.
  v_charged := case
    when p_charged_amount is null or p_charged_amount <= 0 then null
    when p_refund_usd > 0 and v_refund < p_refund_usd then round(p_charged_amount * v_refund / p_refund_usd, 2)
    else p_charged_amount
  end;

  -- Gap-free: taken from a counter updated in THIS transaction, so any rollback below
  -- releases the number (a sequence's nextval is never rolled back).
  v_note := 'CN-' || to_char(now() at time zone 'UTC', 'YYYY')
            || '-' || lpad(public.next_credit_note_number()::text, 6, '0');

  insert into public.order_refunds (refund_reference, order_id, amount_usd, gb_clawed, gb_shortfall, credit_note_number, charged_amount, charged_currency, source)
  values (p_refund_reference, p_order_id, v_refund, v_claw, v_gb - v_claw, v_note,
          v_charged, case when v_charged is null then null else upper(p_charged_currency) end, v_source)
  on conflict (refund_reference) do nothing
  returning refund_reference into v_inserted;

  if v_inserted is null then
    -- Lost a race on the refund reference: nothing was issued, so give the number back
    -- (this transaction still holds the counter's row lock, nobody can have moved it).
    update public.credit_note_counter set last_n = last_n - 1 where id;
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

  -- The customer's open refund request (if any) is answered by this refund.
  update public.refund_requests
  set status = 'refunded', resolved_at = now()
  where order_id = p_order_id and status = 'open';

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

revoke all on function public.apply_order_refund(uuid, text, numeric, numeric, text, text) from public, anon, authenticated;
grant execute on function public.apply_order_refund(uuid, text, numeric, numeric, text, text) to service_role;

insert into public.schema_migrations (filename) values
  ('0096_payments_billing_pass7.sql')
on conflict do nothing;
