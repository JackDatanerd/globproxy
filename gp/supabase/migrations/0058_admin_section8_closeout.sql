-- ============================================================
-- 0058 — Admin section closeout (pass 2)
-- ============================================================
-- 1. clear_referral_flag(): the back-fill paid commission on the GROSS order
--    amount, so clearing a flag after the referred user's order had been
--    refunded paid commission on money that was already returned (the bonus
--    path next to it already used amount - refunded). It now back-fills on
--    the NET amount and skips orders that were refunded in full. It also
--    clears flag_confirmed_at in the same statement as the flag, instead of
--    the route doing it as a second, unchecked write.
-- 2. Deleted accounts can no longer keep the Verified Operator flag (the
--    anonymising patch left it behind, so a deleted operator still counted).
--
-- Idempotent; safe to run against the live DB.

create or replace function public.clear_referral_flag(
  p_referral_id   uuid,
  p_gb            numeric default 1,
  p_min_order_usd numeric default 5
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r              public.referrals%rowtype;
  v_status       text;
  o              record;
  v_res          jsonb;
  v_net          numeric;
  v_count        integer := 0;
  v_total        numeric := 0;
  v_bonus        boolean := false;
begin
  update public.referrals
  set flagged = false, flag_reason = null, flag_confirmed_at = null
  where id = p_referral_id and flagged = true
  returning * into r;
  if not found then
    return null;
  end if;

  select affiliate_status into v_status from public.profiles where id = r.referrer_id;

  for o in
    select id, amount_usd, coalesce(refunded_usd, 0) as refunded_usd, coalesce(paid_at, created_at) as earned_at
    from public.orders
    where user_id = r.referred_user_id
      and bandwidth_credited = true
      and coalesce(is_canary, false) = false
    order by coalesce(paid_at, created_at), created_at
  loop
    v_net := o.amount_usd - o.refunded_usd;
    -- Nothing left of this order to earn on.
    continue when v_net <= 0;

    if v_status = 'approved' then
      v_res := public.record_affiliate_commission(r.id, o.id, v_net, o.earned_at);
      if v_res is not null then
        v_count := v_count + 1;
        v_total := v_total + (v_res->>'commission_usd')::numeric;
      end if;
    elsif v_status is distinct from 'suspended' and not v_bonus then
      if public.credit_referral_bonus(r.id, p_gb, v_net, p_min_order_usd, o.id) then
        v_bonus := true;
      end if;
    end if;
  end loop;

  return jsonb_build_object('commissions_backfilled', v_count, 'commission_usd', v_total, 'bonus_credited', v_bonus);
end;
$$;

revoke all on function public.clear_referral_flag(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.clear_referral_flag(uuid, numeric, numeric) to service_role;

-- 2. Clean up operators whose accounts were already deleted.
update public.profiles
set is_verified_operator = false,
    verified_operator_since = null,
    verified_operator_prev_rate = null,
    verified_operator_prev_rate_lifetime = null
where is_deleted = true
  and (is_verified_operator = true or verified_operator_since is not null);

insert into public.schema_migrations (filename) values
  ('0058_admin_section8_closeout.sql')
on conflict do nothing;
