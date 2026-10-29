-- 0109 — Low-stock alert reaches admin accounts too.
--
-- The reseller dashboard (and POST /api/reseller/settings) let an account with role 'admin' set a
-- low-stock threshold, as admins may allocate bandwidth like a reseller — but this sweep selected
-- only role = 'reseller', so an admin's alert was saved and never sent.

create or replace function public.reseller_low_stock_due()
returns table (out_reseller_id uuid, out_email text, out_name text, out_available_gb numeric, out_threshold_gb numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.profiles p set reseller_low_stock_alerted_at = null
  where p.reseller_low_stock_alerted_at is not null
    and (p.reseller_low_stock_gb is null
         or coalesce((select b.available_gb from public.bandwidth_accounts b where b.user_id = p.id), 0) >= p.reseller_low_stock_gb);

  return query
  select p.id, p.email, p.full_name, coalesce(b.available_gb, 0), p.reseller_low_stock_gb
  from public.profiles p
  left join public.bandwidth_accounts b on b.user_id = p.id
  where p.role in ('reseller', 'admin') and p.reseller_low_stock_gb is not null
    and coalesce(p.is_deleted, false) = false and coalesce(p.is_suspended, false) = false
    and coalesce(b.available_gb, 0) < p.reseller_low_stock_gb
    and p.reseller_low_stock_alerted_at is null;
end;
$$;
revoke all on function public.reseller_low_stock_due() from public, anon, authenticated;
grant execute on function public.reseller_low_stock_due() to service_role;

insert into public.schema_migrations (filename) values
  ('0109_reseller_low_stock_admin.sql')
on conflict do nothing;
