-- ============================================================
-- 0015 — Atomic order-claim + bandwidth-credit
-- ============================================================
-- activateBandwidth() (lib/bandwidth.ts) previously did this as two
-- separate statements:
--   1. UPDATE orders SET payment_status='paid', bandwidth_credited=true
--      WHERE bandwidth_credited=false  (the atomic claim, prevents
--      double-crediting from a racing webhook + verify-payment call)
--   2. supabase.rpc('credit_bandwidth', ...)
--
-- If step 2 failed for any reason (transient DB error, connection drop),
-- the failure was only console.error'd — step 1 had already committed.
-- The order is left permanently marked payment_status='paid' with
-- bandwidth_credited=true, so the claim guard on step 1 means NO future
-- call (webhook redelivery, a manual re-verify, anything) can ever
-- re-enter this path for that order. A customer who paid gets zero GB,
-- silently and permanently, with no automatic recovery — the first
-- anyone hears about it is a support ticket.
--
-- Folding both steps into one plpgsql function fixes this for free: a
-- function body runs inside the same transaction as its caller, so an
-- uncaught error partway through (e.g. credit_bandwidth's insert/update
-- failing) rolls back everything the function did up to that point —
-- including the claim. The order is left exactly as it was before the
-- call, so a retry can complete it cleanly instead of the claim being
-- permanently burned on a credit that never happened.

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
      paid_at            = now()
  where id = p_order_id
    and bandwidth_credited = false
  returning id into v_claimed;

  if v_claimed is null then
    -- Already credited by a concurrent/duplicate call — no-op, not an error.
    return false;
  end if;

  -- Any error raised here (constraint violation, transient failure, etc.)
  -- propagates out of this function uncaught, which rolls back the whole
  -- transaction — the claim above included. See header comment.
  perform public.credit_bandwidth(p_user_id, p_gb);

  return true;
end;
$$;

revoke all on function public.claim_and_credit_order(uuid, uuid, numeric, text) from public;
grant execute on function public.claim_and_credit_order(uuid, uuid, numeric, text) to service_role;
