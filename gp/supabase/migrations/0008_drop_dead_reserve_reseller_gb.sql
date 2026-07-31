-- ============================================================
-- 0008 — Drop dead reserve_reseller_gb()
-- ============================================================
-- Superseded by allocate_reseller_bandwidth() (migration 0004), which does
-- the same job atomically and against the correct column (allocated_gb, not
-- used_gb). Nothing in the application calls reserve_reseller_gb() — it was
-- leftover from an earlier version of the reseller-allocation flow.
drop function if exists public.reserve_reseller_gb(uuid, numeric);
