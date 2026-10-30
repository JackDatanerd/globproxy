-- Proxy lifecycle: allocation drift detector.
-- createCredential() reserves GB in bandwidth_accounts.allocated_gb BEFORE the provider call and the row
-- insert. A Worker killed inside that window leaks the reservation permanently and nothing noticed.
-- Invariant for an ordinary (non-reseller) account:
--   allocated_gb = sum(proxy_credentials.gb_allocated) + archived_used_gb
-- This function reports accounts whose reservation exceeds that by more than 0.01 GB. A create in flight
-- shows up here for a few seconds, so the caller (lib/allocationDrift.ts) reads it twice, a while apart,
-- and only reports accounts whose drift is unchanged. Read-only: it never edits balances; an admin decides
-- how to repair a reported account.
create or replace function public.allocation_drift()
returns table (user_id uuid, allocated_gb numeric, expected_gb numeric, drift_gb numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ba.user_id,
         ba.allocated_gb,
         round(coalesce(s.total, 0) + ba.archived_used_gb, 4),
         round(ba.allocated_gb - (coalesce(s.total, 0) + ba.archived_used_gb), 4)
  from public.bandwidth_accounts ba
  left join (
    select pc.user_id, sum(pc.gb_allocated) as total
    from public.proxy_credentials pc
    group by pc.user_id
  ) s on s.user_id = ba.user_id
  where ba.allocated_gb - (coalesce(s.total, 0) + ba.archived_used_gb) > 0.01
    -- Reseller accounts carry transfers to clients in allocated_gb, so the invariant does not apply.
    and not exists (select 1 from public.reseller_transfers rt where rt.reseller_id = ba.user_id)
    and not exists (select 1 from public.reseller_pending_transfers rp where rp.reseller_id = ba.user_id)
    and not exists (select 1 from public.proxy_credentials x where x.created_by = ba.user_id or (x.user_id = ba.user_id and x.created_by is not null))
  order by 4 desc
  limit 50;
$$;
revoke all on function public.allocation_drift() from public, anon, authenticated;
grant execute on function public.allocation_drift() to service_role;

insert into public.schema_migrations (filename) values
  ('0113_proxy_lifecycle_section4_closeout.sql')
on conflict do nothing;
