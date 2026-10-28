-- Proxy lifecycle pass 12.
-- reprovision_credential() also accepts a CUSTOMER-PAUSED session (status 'suspended',
-- suspended_reason 'customer'). Such a session is not walked by the usage sync, and resuming one whose
-- supplier-side proxy has vanished fails; the admin remediation (re-provision / refund) could not act on it
-- because the function only accepted 'active'. Re-provisioning brings it back as a fresh pending session
-- (the pause is lifted: the customer asked to resume it). Admin- and account-suspended sessions still refuse.
create or replace function public.reprovision_credential(
  p_credential_id uuid,
  p_live_used_gb numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c record;
  v_used numeric;
  v_new  numeric;
begin
  select * into c
  from public.proxy_credentials
  where id = p_credential_id
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;
  if c.created_by is not null then
    raise exception 'Reseller-allocated sessions cannot be re-provisioned automatically' using errcode = '42501';
  end if;
  if c.status <> 'active' and not (c.status = 'suspended' and c.suspended_reason = 'customer') then
    raise exception 'Only an active or customer-paused session can be re-provisioned (status: %)', c.status using errcode = 'P0005';
  end if;

  v_used := greatest(coalesce(c.gb_used, 0), coalesce(p_live_used_gb, 0), 0);
  v_new  := round(c.gb_allocated - v_used, 4);
  if v_new < 0.01 then
    raise exception 'Nothing is left on this session to re-provision (allocated %, used %)', c.gb_allocated, v_used using errcode = 'P0004';
  end if;

  update public.proxy_credentials
  set status = 'pending',
      suspended_reason = null,
      gb_allocated = v_new,
      gb_used = 0,
      upstream_sub_user_id = null,
      upstream_username = null,
      upstream_password = null,
      activated_at = null,
      provision_username = null,
      provision_password = null,
      provision_attempts = 0,
      provisioning_claimed_at = null,
      provision_stalled_at = null,
      pending_reason = null,
      last_provision_error = null,
      upstream_missing_since = null,
      limit_sync_failed_since = null,
      limit_sync_alerted_at = null,
      exhausted_alerted_at = null,
      exhausted_email_due = false,
      low_alerted_pct = null,
      low_email_due = false,
      auto_topup_insufficient_alerted_at = null,
      usage_synced_at = null
  where id = p_credential_id;

  update public.bandwidth_accounts
  set archived_used_gb = archived_used_gb + v_used
  where user_id = c.user_id;

  return jsonb_build_object('gb_allocated', v_new, 'archived_gb', v_used);
end;
$$;

revoke all on function public.reprovision_credential(uuid, numeric) from public, anon, authenticated;
grant execute on function public.reprovision_credential(uuid, numeric) to service_role;

insert into public.schema_migrations (filename) values
  ('0104_proxy_lifecycle_pass12.sql')
on conflict do nothing;
