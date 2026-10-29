-- 0110: c7 audit round — recipient e-mail shape check on invitations; a paid payout with an open
-- refund deduction can no longer be reversed (it would be paid in full and deducted again).
-- Idempotent.
create or replace function public.create_pending_reseller_transfer(
  p_reseller_id uuid, p_email text, p_gb numeric, p_note text default null
)
returns table (out_pending_id uuid, out_total_gb numeric, out_expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_own     text;
  v_updated numeric;
  v_open    integer;
  v_new24   integer;
  v_id      uuid;
  v_total   numeric;
  v_exp     timestamptz;
begin
  if p_gb is null or p_gb < 0.1 then raise exception 'Minimum allocation is 0.1 GB'; end if;
  if p_gb <> round(p_gb, 3) then raise exception 'At most 3 decimal places are allowed'; end if;
  if p_gb > 1000000 then raise exception 'Amount too large'; end if;
  if v_email = '' or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' or length(v_email) > 254 then raise exception 'A valid recipient email is required'; end if;

  select email into v_own from public.profiles where id = p_reseller_id;
  if v_own is not null and public.normalize_email_alias(v_own) = public.normalize_email_alias(v_email) then
    raise exception 'Cannot allocate bandwidth to yourself';
  end if;

  perform 1 from public.bandwidth_accounts where user_id = p_reseller_id for update;

  select count(*) into v_open from public.reseller_pending_transfers
  where reseller_id = p_reseller_id and status = 'pending';
  if v_open >= 100 and not exists (
    select 1 from public.reseller_pending_transfers where reseller_id = p_reseller_id and recipient_email = v_email and status = 'pending'
  ) then
    raise exception 'Too many open invitations — cancel some or wait for them to be claimed.';
  end if;

  -- An invitation is an e-mail to someone who never asked for it: bound how many
  -- NEW addresses one reseller can invite per day (topping up an open invitation
  -- is not new).
  if not exists (
    select 1 from public.reseller_pending_transfers where reseller_id = p_reseller_id and recipient_email = v_email and status = 'pending'
  ) then
    v_new24 := public.reseller_new_recipients_24h(p_reseller_id);
    if v_new24 >= 50 then
      raise exception 'Too many new recipients today — try again tomorrow.';
    end if;
  end if;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_reseller_id and (total_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_updated;
  if v_updated is null then
    raise exception 'Not enough bandwidth in your stock.' using errcode = 'P0001';
  end if;

  insert into public.reseller_pending_transfers (reseller_id, recipient_email, gb_amount, note)
  values (p_reseller_id, v_email, p_gb, nullif(left(trim(coalesce(p_note, '')), 200), ''))
  on conflict (reseller_id, recipient_email) where status = 'pending'
  do update set gb_amount = public.reseller_pending_transfers.gb_amount + excluded.gb_amount,
                note = coalesce(excluded.note, public.reseller_pending_transfers.note),
                expires_at = now() + interval '30 days'
  returning id, gb_amount, expires_at into v_id, v_total, v_exp;

  return query select v_id, v_total, v_exp;
end;
$$;

revoke all on function public.create_pending_reseller_transfer(uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.create_pending_reseller_transfer(uuid, text, numeric, text) to service_role;

create or replace function public.admin_reverse_paid_payout(p_payout_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.affiliate_payouts%rowtype;
  v_n integer;
begin
  select * into p from public.affiliate_payouts where id = p_payout_id for update;
  if not found or p.status <> 'paid' then
    return null;
  end if;
  -- A commission recovered after payout already produced a deduction; reverting the
  -- payout would count it twice.
  if exists (select 1 from public.affiliate_commissions where payout_id = p.id and voided_at is not null) then
    return jsonb_build_object('blocked', 'voided_commissions');
  end if;

  -- A refund after payout leaves an open deduction against these commissions: reverting would pay
  -- the full amount again and deduct it a second time.
  if exists (select 1 from public.affiliate_adjustments a join public.affiliate_commissions c on c.id = a.commission_id
             where c.payout_id = p.id and a.reason = 'refund_after_paid' and a.waived_at is null) then
    return jsonb_build_object('blocked', 'refund_deductions');
  end if;

  update public.affiliate_payouts
     set status = 'pending', paid_at = null, paid_by = null, payment_reference = null, notified_at = null,
         payout_local_currency = null, payout_local_amount = null, payout_fx_rate = null
   where id = p.id;
  update public.affiliate_commissions
     set status = 'pending', paid_at = null
   where payout_id = p.id and status = 'paid';
  get diagnostics v_n = row_count;

  return jsonb_build_object(
    'referrer_id', p.referrer_id, 'amount_usd', p.amount_usd,
    'cycle_start', p.cycle_start, 'cycle_end', p.cycle_end,
    'payment_reference', p.payment_reference, 'commissions_reverted', v_n
  );
end;
$$;

revoke all on function public.admin_reverse_paid_payout(uuid) from public, anon, authenticated;
grant execute on function public.admin_reverse_paid_payout(uuid) to service_role;

insert into public.schema_migrations (filename) values ('0110_section7_c7_round_fixes.sql') on conflict do nothing;
