-- Section 7 — affiliate self-cancel vs. off-platform sending.
--
-- A payout stays 'pending' from the moment the cycle is run until an admin marks it paid, which is
-- when the money is sent by hand (USDT / M-Pesa / bank). In that window the owner could cancel it
-- from /dashboard/referrals: the commissions went back into their balance, the admin's transfer
-- still went out, and the same commissions were paid again next cycle.
--
-- Fix: the owner can cancel only while the payout is (a) not yet picked up for sending
-- (sending_started_at is stamped when an admin exports the pending payouts sheet) and (b) younger
-- than 24 hours. Admins can still void at any time (void_affiliate_payout is unchanged).
-- Idempotent.

alter table public.affiliate_payouts add column if not exists sending_started_at timestamptz;

create or replace function public.owner_cancel_affiliate_payout(p_payout_id uuid, p_referrer_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.affiliate_payouts%rowtype;
begin
  select * into p from public.affiliate_payouts
   where id = p_payout_id and referrer_id = p_referrer_id and status = 'pending' for update;
  if not found then
    return null;
  end if;
  if p.sending_started_at is not null or p.created_at < now() - interval '24 hours' then
    return jsonb_build_object('locked', true);
  end if;
  return public.void_affiliate_payout(p.id);
end;
$$;
revoke all on function public.owner_cancel_affiliate_payout(uuid, uuid) from public, anon, authenticated;
grant execute on function public.owner_cancel_affiliate_payout(uuid, uuid) to service_role;

insert into public.schema_migrations (filename) values
  ('0103_section7_payout_cancel_lock.sql')
on conflict do nothing;
