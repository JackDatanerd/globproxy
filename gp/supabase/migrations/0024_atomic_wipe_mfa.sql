-- ============================================================
-- 0024 — Atomic MFA wipe
-- ============================================================
-- wipeMfa() (lib/mfa.ts), used by both self-service disable and admin
-- reset, previously did this as four separate sequential statements:
--   1. DELETE FROM mfa_totp_factors WHERE user_id = ...
--   2. DELETE FROM mfa_backup_codes WHERE user_id = ...
--   3. DELETE FROM mfa_verified_sessions WHERE user_id = ...
--   4. UPDATE profiles SET mfa_enabled = false WHERE id = ...
--
-- If step 3 or 4 failed for any reason (transient DB error, connection
-- drop), steps 1-2 had already committed: the factor row is gone, but
-- profiles.mfa_enabled is still true from before. The next login then
-- hits exactly this dead end — middleware routes the user to
-- /auth/mfa-verify (since mfa_enabled=true), but verifyFactor() finds no
-- confirmed factor and throws "Two-factor authentication is not set up
-- on this account." Backup codes are gone too by this point (step 2
-- already ran), so there's no self-service way out, and mfa_enabled
-- staying true means middleware never redirects to /auth/mfa-setup
-- either — the account is fully locked out of its own UI, recoverable
-- only via direct DB access. Same bug class claim_and_credit_order
-- (migration 0015) already fixed for order crediting; this is that same
-- fix applied to MFA teardown.
--
-- Folding all four steps into one plpgsql function fixes this for free:
-- the function body runs inside the same transaction as its caller, so
-- an uncaught error partway through rolls back everything done so far.
-- Either the full wipe completes (profiles.mfa_enabled ends up false,
-- matching reality) or none of it does — never a state in between.

create or replace function public.wipe_mfa(p_user_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  delete from public.mfa_totp_factors where user_id = p_user_id;
  delete from public.mfa_backup_codes where user_id = p_user_id;
  delete from public.mfa_verified_sessions where user_id = p_user_id;

  -- Runs last so that if anything above fails, this uncommitted change
  -- rolls back too — mfa_enabled only ever flips to false in the same
  -- transaction as a fully-completed wipe, never ahead of one.
  update public.profiles set mfa_enabled = false where id = p_user_id;
end;
$$;

revoke all on function public.wipe_mfa(uuid) from public;
grant execute on function public.wipe_mfa(uuid) to service_role;

-- One-time repair for any account already stuck in the desynced state
-- this migration prevents going forward: mfa_enabled=true with no
-- confirmed factor to verify against. Matches exactly the manual query
-- used to unblock the account that surfaced this bug — folded into the
-- migration so it's applied consistently rather than by hand per-account.
update public.profiles p
set mfa_enabled = false
where p.mfa_enabled = true
  and not exists (
    select 1 from public.mfa_totp_factors f
    where f.user_id = p.id and f.confirmed = true
  );
