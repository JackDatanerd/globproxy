-- ============================================================
-- 0013 — Stop defaulting proxy_credentials.host to the real
-- upstream hostname
-- ============================================================
-- The column default was the real,
-- un-white-labeled upstream hostname. Every current insert path
-- (app/api/dashboard/proxies, app/api/v1/sub-users,
-- lib/bandwidth.ts activation) sets `host` explicitly, so this
-- default has never actually been written to a live row — but it's a
-- landmine: any future insert that forgets to set `host` (a new admin
-- tool, a manual fix, a future migration/backfill) would silently
-- leak the supplier's real domain to a customer instead of failing
-- loudly. See lib/upstream.ts's own comment: "always expose this to
-- users, never the upstream hostname".
--
-- Safe to run against the live DB: this only changes the default
-- applied to *future* inserts that omit the column; it does not touch
-- any existing row.

alter table public.proxy_credentials
  alter column host set default 'proxy.globproxy.com';
