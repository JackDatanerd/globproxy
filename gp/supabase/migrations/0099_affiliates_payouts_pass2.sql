-- 0099: Affiliates & payouts (section 7) pass — an admin void of referral earnings now notifies the customers.
--
-- admin_void_referral_earnings took the standard GB bonus back from both accounts but only wrote
-- admin_audit_log, so the customers' balances dropped with no webhook or email. The refund path
-- (reverse_referral_bonus_on_refund) queues a referral_bonus_reversal_events row that the hourly
-- sweep turns into notices; the admin path now queues the same row.

create or replace function public.admin_void_referral_earnings(p_referral_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rf public.referrals%rowtype;
  cid uuid;
  res jsonb;
  v_voided integer := 0;
  v_clawed integer := 0;
  v_usd numeric := 0;
  v_avail numeric;
  v_claw_a numeric := 0;
  v_claw_b numeric := 0;
begin
  select * into rf from public.referrals where id = p_referral_id for update;
  if not found then
    return null;
  end if;

  update public.referrals
  set flagged = true,
      flag_reason = coalesce(flag_reason, 'admin_flagged'),
      flag_confirmed_at = coalesce(flag_confirmed_at, now())
  where id = rf.id;

  for cid in select id from public.affiliate_commissions where referral_id = rf.id and status <> 'void' and voided_at is null loop
    res := public.admin_void_commission(cid, p_reason);
    if res is not null then
      v_usd := v_usd + coalesce((res ->> 'amount_usd')::numeric, 0);
      if res ->> 'action' = 'clawback_recorded' then v_clawed := v_clawed + 1; else v_voided := v_voided + 1; end if;
    end if;
  end loop;

  -- The standard GB bonus (non-affiliate referrer) is earnings too: take back
  -- what is still unspent, from both sides, exactly like a refund does.
  if rf.gb_bonus_credited_at is not null and rf.gb_bonus_reversed_at is null and coalesce(rf.gb_bonus_amount, 0) > 0 then
    perform 1 from public.bandwidth_accounts
    where user_id in (rf.referrer_id, rf.referred_user_id) order by user_id for update;

    select greatest(coalesce(available_gb, 0), 0) into v_avail from public.bandwidth_accounts where user_id = rf.referrer_id;
    v_claw_a := least(rf.gb_bonus_amount, coalesce(v_avail, 0));
    if v_claw_a > 0 then
      update public.bandwidth_accounts set total_gb = total_gb - v_claw_a where user_id = rf.referrer_id;
    end if;

    select greatest(coalesce(available_gb, 0), 0) into v_avail from public.bandwidth_accounts where user_id = rf.referred_user_id;
    v_claw_b := least(rf.gb_bonus_amount, coalesce(v_avail, 0));
    if v_claw_b > 0 then
      update public.bandwidth_accounts set total_gb = total_gb - v_claw_b where user_id = rf.referred_user_id;
    end if;

    update public.referrals set gb_bonus_reversed_at = now() where id = rf.id;
    -- Queue the clawback exactly like the refund path does, so the hourly sweep tells both
    -- accounts (webhook + email) that GB was taken back instead of it vanishing silently.
    if v_claw_a > 0 or v_claw_b > 0 then
      insert into public.referral_bonus_reversal_events (referral_id, referrer_id, referred_user_id, gb_from_referrer, gb_from_referred)
      values (rf.id, rf.referrer_id, rf.referred_user_id, v_claw_a, v_claw_b)
      on conflict (referral_id) do nothing;
    end if;
    insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
    values (null, 'referral_bonus_reversed', rf.referrer_id, rf.id::text,
            jsonb_build_object('referral_id', rf.id, 'bonus_gb', rf.gb_bonus_amount, 'via', 'admin_void',
                               'clawed_from_referrer_gb', v_claw_a, 'clawed_from_referred_gb', v_claw_b));
  end if;

  return jsonb_build_object('referrer_id', rf.referrer_id, 'voided', v_voided, 'clawbacks', v_clawed, 'amount_usd', v_usd,
                            'bonus_clawed_referrer_gb', v_claw_a, 'bonus_clawed_referred_gb', v_claw_b);
end;
$$;
revoke all on function public.admin_void_referral_earnings(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_void_referral_earnings(uuid, text) to service_role;

insert into public.schema_migrations (filename) values
  ('0099_affiliates_payouts_pass2.sql')
on conflict do nothing;
