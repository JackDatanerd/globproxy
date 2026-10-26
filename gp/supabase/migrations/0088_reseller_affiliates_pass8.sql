-- ─────────────────────────────────────────────────────────────────────
-- 0088 · Reseller, affiliates & payouts — independent pass 8
--
--  1. record_affiliate_commission() is refund-aware. The refund trigger
--     (reduce_commission_on_refund) only fires when orders.refunded_usd RISES and
--     returns early when no commission exists yet. A commission recorded AFTER the
--     refund (a retried post-credit step, or clear_referral_flag() backfilling an
--     order the admin had already refunded) was computed on the GROSS amount and
--     nothing ever reduced it — the affiliate was paid commission on money that
--     went back to the customer. The order row is now read (FOR SHARE, so a refund
--     committing concurrently either lands first and is seen, or waits and its
--     trigger then sees this commission) and the commission is sized on what is
--     left of the order; a fully refunded order earns nothing.
--  2. One-time repair of commissions that already exist on refunded orders
--     (pending: shrink / void and take the difference off an unpaid payout; paid:
--     record the refund_after_paid clawback), same maths as the trigger.
--  3. mark_affiliate_payout_paid() takes an optional expected amount. The admin
--     screen shows a payout amount, a refund can shrink the payout before the
--     click, and the money is sent outside the app — so "Mark paid" now refuses
--     (atomically, in the same UPDATE) when the amount on record is no longer the
--     one the admin saw.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────

-- 1 ───────────────────────────────────────────────────────────────────
create or replace function public.record_affiliate_commission(
  p_referral_id  uuid,
  p_order_id     uuid,
  p_gross_amount numeric,
  p_earned_at    timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_referrer_id uuid;
  v_referred_id uuid;
  v_created_at timestamptz;
  v_flagged boolean;
  v_affiliate_status text;
  v_deleted boolean;
  v_suspended boolean;
  v_intro_rate numeric;
  v_lifetime_rate numeric;
  v_h_intro numeric;
  v_h_life numeric;
  v_rate numeric;
  v_id uuid;
  v_amt numeric;
  v_first boolean;
  v_o_amount numeric;
  v_o_refunded numeric;
  v_keep numeric := 1;
  v_commission numeric;
begin
  if p_gross_amount is null or p_gross_amount <= 0 then
    return null;
  end if;

  select referrer_id, referred_user_id, created_at, flagged
    into v_referrer_id, v_referred_id, v_created_at, v_flagged
  from public.referrals where id = p_referral_id;

  if v_referrer_id is null or coalesce(v_flagged, false) then
    return null;
  end if;

  select affiliate_status,
         coalesce(affiliate_commission_rate, 0.30),
         coalesce(affiliate_commission_rate_lifetime, 0.15),
         is_deleted, is_suspended
    into v_affiliate_status, v_intro_rate, v_lifetime_rate, v_deleted, v_suspended
  from public.profiles where id = v_referrer_id;

  if v_affiliate_status is distinct from 'approved'
     or coalesce(v_deleted, false) or coalesce(v_suspended, false) then
    return null;
  end if;

  -- What is left of the order after refunds (0088). FOR SHARE: see header.
  select coalesce(amount_usd, 0), coalesce(refunded_usd, 0) into v_o_amount, v_o_refunded
  from public.orders where id = p_order_id for share;
  if found and v_o_amount > 0 then
    v_keep := 1 - least(v_o_refunded / v_o_amount, 1);
    if v_keep <= 0 then
      return null; -- fully refunded: nothing to earn on
    end if;
  end if;

  select h.intro_rate, h.lifetime_rate into v_h_intro, v_h_life
  from public.affiliate_rate_history h
  where h.user_id = v_referrer_id and h.effective_from <= coalesce(p_earned_at, now())
  order by h.effective_from desc limit 1;
  if not found then
    select h.intro_rate, h.lifetime_rate into v_h_intro, v_h_life
    from public.affiliate_rate_history h
    where h.user_id = v_referrer_id order by h.effective_from asc limit 1;
  end if;
  v_intro_rate := coalesce(v_h_intro, v_intro_rate);
  v_lifetime_rate := coalesce(v_h_life, v_lifetime_rate);

  v_rate := case when coalesce(p_earned_at, now()) <= v_created_at + interval '90 days' then v_intro_rate else v_lifetime_rate end;

  v_commission := round(p_gross_amount * v_keep * v_rate, 2);
  if v_commission <= 0 and v_rate > 0 then
    return null; -- refunded down to less than a cent of commission
  end if;

  insert into public.affiliate_commissions
    (referral_id, referrer_id, referred_user_id, order_id, gross_amount_usd, commission_rate, commission_amount_usd)
  values
    (p_referral_id, v_referrer_id, v_referred_id, p_order_id, p_gross_amount, v_rate, v_commission)
  on conflict (order_id) do nothing
  returning id, commission_amount_usd into v_id, v_amt;

  if v_id is null then
    return null; -- already recorded for this order
  end if;

  v_first := not exists (
    select 1 from public.affiliate_commissions where referral_id = p_referral_id and id <> v_id
  );
  return jsonb_build_object('commission_usd', v_amt, 'rate', v_rate, 'first', v_first);
end;
$$;
revoke all on function public.record_affiliate_commission(uuid, uuid, numeric, timestamptz) from public, anon, authenticated;
grant execute on function public.record_affiliate_commission(uuid, uuid, numeric, timestamptz) to service_role;

-- 2 ───────────────────────────────────────────────────────────────────
do $$
declare
  c          record;
  v_ratio    numeric;
  v_new      numeric;
  v_delta    numeric;
  v_have     numeric;
  v_deleted  boolean;
  v_pay_amt  numeric;
begin
  for c in
    select ac.id, ac.status, ac.payout_id, ac.referrer_id, ac.order_id, ac.gross_amount_usd,
           ac.commission_rate, ac.commission_amount_usd, ac.voided_at,
           o.amount_usd as o_amount, o.refunded_usd as o_refunded
    from public.affiliate_commissions ac
    join public.orders o on o.id = ac.order_id
    where coalesce(o.refunded_usd, 0) > 0 and coalesce(o.amount_usd, 0) > 0
      and ac.status in ('pending', 'paid') and ac.voided_at is null
    order by ac.created_at
  loop
    v_ratio := least(c.o_refunded / c.o_amount, 1);
    v_new := case when v_ratio >= 1 then 0 else round(c.gross_amount_usd * (1 - v_ratio) * c.commission_rate, 2) end;
    if v_new >= c.commission_amount_usd then continue; end if;

    if c.status = 'paid' then
      select coalesce(is_deleted, false) into v_deleted from public.profiles where id = c.referrer_id;
      select coalesce(-sum(amount_usd), 0) into v_have
      from public.affiliate_adjustments where commission_id = c.id and reason = 'refund_after_paid';
      v_delta := round((c.commission_amount_usd - v_new) - v_have, 2);
      if v_delta > 0 and not coalesce(v_deleted, false) then
        insert into public.affiliate_adjustments (referrer_id, commission_id, order_id, amount_usd, reason)
        values (c.referrer_id, c.id, c.order_id, -v_delta, 'refund_after_paid');
        insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
        values (null, 'commission_refund_after_paid', c.referrer_id, c.order_id::text,
                jsonb_build_object('commission_id', c.id, 'clawback_usd', v_delta, 'via', '0088_repair'));
      end if;
    else
      v_delta := c.commission_amount_usd - v_new;
      update public.affiliate_commissions
         set commission_amount_usd = v_new,
             status = case when v_new = 0 then 'void' else status end
       where id = c.id;
      if c.payout_id is not null then
        update public.affiliate_payouts
           set amount_usd = greatest(amount_usd - v_delta, 0)
         where id = c.payout_id and status = 'pending'
        returning amount_usd into v_pay_amt;
        if found and v_pay_amt <= 0 then
          delete from public.affiliate_payouts where id = c.payout_id;
        end if;
      end if;
      insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
      values (null, 'commission_reduced_by_refund', c.referrer_id, c.order_id::text,
              jsonb_build_object('commission_id', c.id, 'from_usd', c.commission_amount_usd, 'to_usd', v_new, 'via', '0088_repair'));
    end if;
  end loop;
end $$;

-- 3 ───────────────────────────────────────────────────────────────────
drop function if exists public.mark_affiliate_payout_paid(uuid, uuid, text);

create or replace function public.mark_affiliate_payout_paid(
  p_payout_id        uuid,
  p_paid_by          uuid default null,
  p_reference        text default null,
  p_expected_amount  numeric default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claimed uuid;
begin
  update public.affiliate_payouts
  set status = 'paid', paid_at = now(), paid_by = p_paid_by, payment_reference = nullif(btrim(p_reference), '')
  where id = p_payout_id and status = 'pending'
    and amount_usd > 0
    and (p_expected_amount is null or amount_usd = round(p_expected_amount, 2))
  returning id into v_claimed;

  if v_claimed is null then
    return false;
  end if;

  update public.affiliate_commissions
  set status = 'paid', paid_at = now()
  where payout_id = v_claimed and status = 'pending';

  return true;
end;
$$;
revoke all on function public.mark_affiliate_payout_paid(uuid, uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.mark_affiliate_payout_paid(uuid, uuid, text, numeric) to service_role;

insert into public.schema_migrations (filename) values
  ('0088_reseller_affiliates_pass8.sql')
on conflict do nothing;
