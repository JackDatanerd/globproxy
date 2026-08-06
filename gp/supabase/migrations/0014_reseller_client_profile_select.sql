-- ============================================================
-- 0014 — Let a reseller see their own clients' profiles
-- ============================================================
-- Safe to run against the live DB: idempotent (DROP ... IF EXISTS before
-- CREATE).
--
-- profiles only ever had one SELECT policy: "Own profile" (auth.uid() = id).
-- /reseller/users, /reseller/earnings, and /reseller/transfers all join
-- reseller_transfers -> profiles (via the recipient_id FK) using the
-- RLS-scoped session client to show each client's email. PostgREST filters
-- embedded joins through the embedded table's own RLS — so for every
-- transfer, that join came back null (the reseller's auth.uid() is never
-- the recipient's id), and all three pages silently rendered empty/blank
-- client rows. Fails closed (no cross-tenant leak), but broken in
-- production for the entire reseller-facing surface.
--
-- Scoped tightly: a reseller can only see a client's profile if a real
-- reseller_transfers row ties that reseller to that recipient — not every
-- profile, not another reseller's clients.

drop policy if exists "Resellers can view own client profiles" on public.profiles;
create policy "Resellers can view own client profiles" on public.profiles for select
  using (
    exists (
      select 1 from public.reseller_transfers rt
      where rt.recipient_id = profiles.id and rt.reseller_id = auth.uid()
    )
  );
