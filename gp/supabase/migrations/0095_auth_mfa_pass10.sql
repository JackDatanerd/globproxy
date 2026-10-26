-- 0095: Auth & MFA pass 10.
--
-- confirm_totp_enrollment_atomic now compare-and-sets on the pending secret the caller
-- actually verified. confirmEnrollment read the secret, checked the code against it, then
-- called this function, which confirmed whatever secret was current at that instant. A second
-- mfa_start_enrollment (another tab, after the 15-minute reuse window) landing in between
-- replaced the pending seed, so the account was confirmed on a secret the person never
-- proved. Same class as the rekey fix in 0092.
--
-- p_expected_secret defaults to null (the old unconditional behaviour) so a build that still
-- calls the 3-argument form keeps working during a deploy. The 3-argument function is dropped
-- so calls resolve to this one. A mismatch raises P0002 ("start setup again").

drop function if exists public.confirm_totp_enrollment_atomic(uuid, integer, text[]);

create or replace function public.confirm_totp_enrollment_atomic(
  p_user_id uuid, p_used_counter integer, p_hashes text[], p_expected_secret text default null
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_confirmed boolean; v_secret text;
begin
  select confirmed, secret into v_confirmed, v_secret
    from public.mfa_totp_factors where user_id = p_user_id for update;
  if not found then
    raise exception 'No pending MFA enrollment found for this account.' using errcode = 'P0002';
  end if;
  if v_confirmed then
    raise exception 'MFA is already enabled for this account.' using errcode = 'P0001';
  end if;
  if p_expected_secret is not null and v_secret is distinct from p_expected_secret then
    raise exception 'The pending authenticator changed; start setup again.' using errcode = 'P0002';
  end if;

  update public.mfa_totp_factors
    set confirmed = true, confirmed_at = now(), failed_attempts = 0, locked_until = null,
        last_used_at = now(), last_used_counter = p_used_counter
    where user_id = p_user_id;
  update public.profiles set mfa_enabled = true where id = p_user_id;

  delete from public.mfa_backup_codes where user_id = p_user_id and used_at is null;
  insert into public.mfa_backup_codes (user_id, code_hash)
    select p_user_id, h from unnest(p_hashes) as h;

  update public.mfa_recovery_requests
     set cancelled_at = now()
   where user_id = p_user_id and completed_at is null and cancelled_at is null;
end;
$$;

revoke all on function public.confirm_totp_enrollment_atomic(uuid, integer, text[], text) from public, anon, authenticated;
grant execute on function public.confirm_totp_enrollment_atomic(uuid, integer, text[], text) to service_role;

insert into public.schema_migrations (filename) values
  ('0095_auth_mfa_pass10.sql')
on conflict do nothing;
