-- ============================================================
-- 0023 — proxy_sessions: enforce credential_id ownership
-- ============================================================
-- INSERT and UPDATE policies on proxy_sessions only ever checked
-- auth.uid() = user_id — nothing validated that credential_id actually
-- belongs to that same user. The app's own routes always set/check both
-- together (POST validates the credential row first; PATCH never exposes
-- credential_id as a writable field at all), so this was never reachable
-- through the UI. But RLS is the backstop for exactly this kind of gap —
-- a direct PostgREST call (INSERT or UPDATE) with a foreign credential_id
-- and the caller's own user_id passes both policies as written today,
-- creating a session row that structurally crosses tenant boundaries.
--
-- Traced every current read path (dashboard/proxies/[id]/sessions GET,
-- dashboard/sessions/[sessionId] PATCH/DELETE) — both already double-filter
-- on credential_id AND user_id, so this isn't an active cross-tenant data
-- leak today. It's still a real integrity violation worth closing before
-- launch: nothing should be able to persist a session row whose
-- credential_id points at another tenant's credential, regardless of
-- whether today's code happens not to join through it unsafely.

drop policy if exists "Users can create their own sessions" on public.proxy_sessions;
create policy "Users can create their own sessions"
  on public.proxy_sessions for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.proxy_credentials pc
      where pc.id = credential_id and pc.user_id = auth.uid()
    )
  );

drop policy if exists "Users can update their own sessions" on public.proxy_sessions;
create policy "Users can update their own sessions"
  on public.proxy_sessions for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.proxy_credentials pc
      where pc.id = credential_id and pc.user_id = auth.uid()
    )
  );
