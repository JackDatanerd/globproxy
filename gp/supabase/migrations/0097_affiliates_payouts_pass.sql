-- 0097: Affiliates & payouts (section 7) pass — reversing a paid payout also clears the M-Pesa shilling record.
--
-- admin_reverse_paid_payout put a payout back to 'pending' but left payout_local_currency /
-- payout_local_amount / payout_fx_rate (what was "actually sent" in KES) on the row, so a
-- reversed payout whose money never arrived kept showing — and exporting — a shilling amount
-- and rate as if it had been sent. It is the 0073 body with only those three columns cleared.
--
-- Idempotent.

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

insert into public.schema_migrations (filename) values
  ('0097_affiliates_payouts_pass.sql')
on conflict do nothing;
