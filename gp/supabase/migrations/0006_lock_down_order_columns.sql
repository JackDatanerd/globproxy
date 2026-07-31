-- ============================================================
-- 0006 — Lock down what "cancel my order" can actually change
-- ============================================================
-- The "Cancel own pending order" RLS policy on orders only checks that the
-- FINAL payment_status is 'cancelled' — RLS doesn't restrict which columns
-- an UPDATE touches, only whether the resulting row passes the check. A
-- client could send { payment_status: 'cancelled', amount_usd: 0.01 } (or
-- tamper with gb_amount, or anything else on their own pending order) and
-- it would pass. In practice this isn't a profitable exploit today — the
-- amount actually charged and the GB actually credited both come from
-- immutable Paystack metadata set at checkout, not from this row, and a
-- mismatch just makes the webhook refuse to credit — but it corrupts this
-- customer's own order history and undermines the "amount mismatch"
-- integrity check for no reason. Mirrors the existing
-- protect_privileged_profile_columns pattern: same technique already used
-- on the profiles table.

create or replace function public.protect_order_columns()
returns trigger
language plpgsql
security definer
as $$
declare
  caller_is_admin boolean;
begin
  if auth.uid() is null then
    return new; -- service-role client (webhook, cron, activateBandwidth) — app code already gates this
  end if;

  select (role = 'admin') into caller_is_admin
  from public.profiles where id = auth.uid();

  if coalesce(caller_is_admin, false) then
    return new;
  end if;

  -- A non-admin owner can only ever flip pending -> cancelled. Everything
  -- else about the row is pinned to its previous value.
  new.user_id             := old.user_id;
  new.plan_id              := old.plan_id;
  new.gb_amount            := old.gb_amount;
  new.amount_usd           := old.amount_usd;
  new.payment_method       := old.payment_method;
  new.paystack_reference   := old.paystack_reference;
  new.bandwidth_credited   := old.bandwidth_credited;
  new.paid_at              := old.paid_at;
  new.created_at           := old.created_at;

  return new;
end;
$$;

drop trigger if exists protect_order_columns on public.orders;
create trigger protect_order_columns
  before update on public.orders
  for each row execute procedure public.protect_order_columns();
