-- ============================================================
-- 0026 — Atomic MFA enrollment confirmation
-- ============================================================
-- This is the exact same bug class migration 0024 fixed — just the other
-- code path. 0024 made wipeMfa() (disable / admin reset) atomic because a
-- partial failure there could leave profiles.mfa_enabled=true with no
-- factor to verify against. confirmEnrollment() (lib/mfa.ts) had the
-- identical shape and was never touched:
--
--   1. UPDATE mfa_totp_factors SET confirmed = true ...   (no error check)
--   2. UPDATE profiles SET mfa_enabled = true ...          (unconditional)
--
-- Write #1 had no `error` check at all. If it fails for any reason
-- (transient DB error, statement timeout — this runs on the service-role
-- client, so RLS isn't the risk here, but an unchecked write is an
-- unchecked write regardless of why it failed), write #2 still runs
-- unconditionally and flips profiles.mfa_enabled to true anyway.
-- confirmEnrollment() then hands back backup codes and a valid session
-- token — from the user's side, setup looked completely successful.
--
-- The break only surfaces later: middleware.ts only ever checks
-- profiles.mfa_enabled — now true — so it routes the user to
-- /auth/mfa-verify, never back to /auth/mfa-setup. verifyFactor() then
-- looks up the *actual* factor row, finds confirmed = false, and throws
-- "Two-factor authentication is not set up on this account." It gates on
-- factor.confirmed before it even looks at the code typed in, so this
-- happens identically for a fresh TOTP code or a backup code — no
-- self-service way out. Same dead end 0024 already documented for the
-- wipe direction, reached from the opposite side.
--
-- Fix: fold both writes into one transaction, same pattern as wipe_mfa.
-- If the factor update doesn't find a row, the whole thing raises and
-- rolls back — mfa_enabled never flips to true unless the factor
-- genuinely did.

create or replace function public.confirm_totp_enrollment(
  p_user_id uuid,
  p_used_counter integer
)
returns void language plpgsql security definer as $$
declare
  v_updated uuid;
begin
  update public.mfa_totp_factors
  set confirmed = true,
      confirmed_at = now(),
      failed_attempts = 0,
      locked_until = null,
      last_used_at = now(),
      last_used_counter = p_used_counter
  where user_id = p_user_id
  returning user_id into v_updated;

  if v_updated is null then
    -- No pending enrollment row for this user — nothing to confirm.
    -- Raising here (rather than silently returning) is what stops
    -- profiles.mfa_enabled from ever being set on its own; the caller
    -- surfaces this as "start setup again."
    raise exception 'No pending MFA enrollment found for this account.' using errcode = 'P0002';
  end if;

  update public.profiles set mfa_enabled = true where id = p_user_id;
end;
$$;

revoke all on function public.confirm_totp_enrollment(uuid, integer) from public;
grant execute on function public.confirm_totp_enrollment(uuid, integer) to service_role;

-- ── One-time data repair ────────────────────────────────────────
-- 0024 already ran this exact repair for accounts stuck via the wipe-side
-- race. Any account that got stuck via *this* (confirm-side) race since
-- then wouldn't have been touched by that earlier repair, so it's run
-- again here — idempotent, matches the identical query from 0024. Safe
-- direction: this only ever *lowers* mfa_enabled back to false for
-- accounts that were never really confirmed, sending them to
-- /auth/mfa-setup (a real re-enrollment) on their next protected request
-- — it can't grant access that wasn't already effectively broken.
update public.profiles p
set mfa_enabled = false
where p.mfa_enabled = true
  and not exists (
    select 1 from public.mfa_totp_factors f
    where f.user_id = p.id and f.confirmed = true
  );

