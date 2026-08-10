-- ============================================================
-- 0022 — TOTP replay protection
-- ============================================================
-- otpauth's TOTP.validate() (used throughout lib/mfa.ts) checks whether a
-- code is CORRECT for some period within its window — it says nothing
-- about whether that exact code was already accepted once already. Without
-- tracking that, the same 6-digit code (shoulder-surfed, grabbed from a
-- compromised authenticator app, replayed from a captured request/log)
-- could be submitted twice in a row and succeed both times, for as long as
-- it stays within its ~30-90s validity window (window: 1 either side).
--
-- last_used_counter stores the absolute 30-second period index of the last
-- successfully-consumed TOTP code (see lib/mfa.ts's validateTotpOnce()) —
-- any code whose own period counter is <= this value is rejected as a
-- replay, regardless of whether it's otherwise numerically correct. Only
-- covers the TOTP path; backup codes already have independent single-use
-- protection via mfa_backup_codes.used_at.

alter table public.mfa_totp_factors
  add column if not exists last_used_counter bigint;
