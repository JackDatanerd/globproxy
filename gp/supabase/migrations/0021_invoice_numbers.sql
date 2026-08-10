-- ============================================================
-- 0021 — Sequential invoice numbers for paid orders
-- ============================================================
-- The Billing page has never had an invoice/export feature. The closest
-- thing to an invoice identifier today is paystack_reference — but that's
-- an opaque payment-gateway transaction id, assigned at order-creation
-- time (before payment even succeeds, so a cancelled/failed order gets
-- one too), with no guarantee of being sequential the way an invoice
-- number is expected to be for bookkeeping/tax purposes.
--
-- invoice_number is assigned exactly once, at the same moment an order is
-- atomically claimed as paid in claim_and_credit_order() (migration
-- 0015) — never at order-creation (a pending/cancelled/failed order never
-- gets one) and never from application code, which would reintroduce the
-- exact race 0015 was written to close: a webhook and a manual
-- verify-payment call landing at the same time. Piggy-backing the
-- assignment onto that existing atomic claim means there's no new race
-- condition to introduce here, and no order can ever end up with two
-- different invoice numbers or a gap where "paid" but "un-invoiced".
--
-- Numbered 0021 (not 0018) since 0018/0019/0020 (webhook endpoints,
-- default auto-topup, MFA) landed in the same window this was written in.

create sequence if not exists public.invoice_number_seq;

alter table public.orders
  add column if not exists invoice_number text unique;

-- Backfill: any order that was already paid before this migration ran
-- gets a number now, assigned in paid_at order (oldest first) so the
-- sequence at least reads chronologically for historical orders, even
-- though — unlike every order from this point forward — it wasn't
-- generated at the actual moment each one was paid. 'refunded' is
-- included: those orders were genuinely paid and invoiced at the time,
-- and a later refund doesn't erase that history.
with to_number as (
  select id, row_number() over (order by paid_at asc nulls last, created_at asc) as rn
  from public.orders
  where payment_status in ('paid', 'refunded')
    and invoice_number is null
)
update public.orders o
set invoice_number = 'INV-' || to_char(coalesce(o.paid_at, o.created_at), 'YYYY')
      || '-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0')
from to_number t
where o.id = t.id;

create or replace function public.claim_and_credit_order(
  p_order_id uuid,
  p_user_id uuid,
  p_gb numeric,
  p_paystack_reference text
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_claimed uuid;
begin
  -- Atomic claim — only one caller's UPDATE can match a given order.
  update public.orders
  set payment_status     = 'paid',
      paystack_reference = p_paystack_reference,
      bandwidth_credited = true,
      paid_at             = now(),
      invoice_number      = 'INV-' || to_char(now(), 'YYYY')
                             || '-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0')
  where id = p_order_id
    and bandwidth_credited = false
  returning id into v_claimed;

  if v_claimed is null then
    -- Already credited by a concurrent/duplicate call — no-op, not an error.
    return false;
  end if;

  -- Any error raised here (constraint violation, transient failure, etc.)
  -- propagates out of this function uncaught, which rolls back the whole
  -- transaction — the claim AND the invoice_number assignment included.
  perform public.credit_bandwidth(p_user_id, p_gb);

  return true;
end;
$$;

revoke all on function public.claim_and_credit_order(uuid, uuid, numeric, text) from public;
grant execute on function public.claim_and_credit_order(uuid, uuid, numeric, text) to service_role;

-- Postgres doesn't auto-grant sequence USAGE to PUBLIC by default, so this
-- is belt-and-suspenders rather than closing a real hole — but it matches
-- the explicit deny-by-default posture migration 0012 established for
-- every other privileged object in this schema. nextval() only needs to
-- work for claim_and_credit_order's definer (the function is `security
-- definer`); no caller ever needs direct sequence access.
revoke all on sequence public.invoice_number_seq from public;
