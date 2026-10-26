-- 0092: Auth & MFA pass 9.
--
-- mfa_rekey_confirm now compare-and-sets on the pending secret the caller actually verified.
-- Before, confirmRekey read pending_secret, checked the code against it, then called the RPC,
-- which swapped in whatever pending secret was current at that instant. A second
-- mfa_rekey_start (another tab) landing in between replaced the pending seed, so the live
-- secret became one the person never proved and their authenticator no longer matched.
--
-- p_expected_pending defaults to null (the old unconditional behaviour) so a build that still
-- calls the 3-argument form keeps working during a deploy. The 3-argument function is dropped
-- so the call resolves unambiguously to this one.

drop function if exists public.mfa_rekey_confirm(uuid, bigint, interval);

create or replace function public.mfa_rekey_confirm(
  p_user_id uuid, p_counter bigint, p_max_age interval, p_expected_pending text default null
)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.mfa_totp_factors
     set secret = pending_secret,
         last_used_counter = p_counter,
         last_used_at = now(),
         failed_attempts = 0,
         locked_until = null,
         pending_secret = null,
         pending_created_at = null
   where user_id = p_user_id
     and confirmed
     and pending_secret is not null
     and pending_created_at > now() - p_max_age
     and (p_expected_pending is null or pending_secret = p_expected_pending);
  return found;
end;
$$;

revoke all on function public.mfa_rekey_confirm(uuid, bigint, interval, text) from public, anon, authenticated;
grant execute on function public.mfa_rekey_confirm(uuid, bigint, interval, text) to service_role;
