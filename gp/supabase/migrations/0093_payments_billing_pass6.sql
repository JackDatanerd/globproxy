-- 0093: Payments & billing pass 6 — gap-free invoice numbers.
--
-- Invoice numbers were drawn from a Postgres sequence inside claim_and_credit_order. Sequences
-- are not transactional: when the claim later rolled back (credit_bandwidth failed, or the
-- worker died mid-call) the number was consumed anyway, leaving a hole in the invoice series —
-- which migration 0038's comment promised could not happen. Many tax regimes expect an unbroken
-- sequence, and a hole is what an auditor asks about.
--
-- next_invoice_number() takes the next value from a one-row counter updated in the caller's
-- transaction: a rollback releases it, and concurrent claims queue on the row lock (payments
-- are rare and the transaction is short). Numbering continues from the highest number already
-- issued, so nothing existing changes.

create table if not exists public.invoice_counter (
  id        boolean primary key default true check (id),
  last_n    bigint not null default 0
);
alter table public.invoice_counter enable row level security;
revoke all on public.invoice_counter from public, anon, authenticated;

insert into public.invoice_counter (id, last_n)
select true, greatest(
  coalesce((select max(substring(invoice_number from '^INV-\d{4}-(\d+)$')::bigint)
              from public.orders where invoice_number ~ '^INV-\d{4}-\d+$'), 0),
  coalesce((select case when is_called then last_value else 0 end from public.invoice_number_seq), 0)
)
on conflict (id) do nothing;

create or replace function public.next_invoice_number()
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.invoice_counter set last_n = last_n + 1 where id returning last_n;
$$;

revoke all on function public.next_invoice_number() from public, anon, authenticated;
grant execute on function public.next_invoice_number() to service_role;

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
             || '-' || lpad(public.next_invoice_number()::text, 6, '0')
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

revoke all on function public.claim_and_credit_order(uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.claim_and_credit_order(uuid, uuid, numeric, text) to service_role;

insert into public.schema_migrations (filename) values
  ('0093_payments_billing_pass6.sql')
on conflict do nothing;
