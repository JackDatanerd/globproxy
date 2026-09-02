-- ============================================================
-- 0036 — Payment failure alerting, canary payments, support reports
-- ============================================================
-- All three come out of the same incident: payments started failing in
-- production (real customer cards declining post-launch) and nothing
-- surfaced it anywhere except manually opening /admin/orders. Before this,
-- the webhook only ever handled charge.success — a declined charge just
-- left the order sitting 'pending' until the 24h cron cleanup (runCleanup
-- in app/api/cron/[task]/route.ts) silently flipped it to 'failed' with no
-- alert and no reason recorded.
--
-- 1. orders.failure_reason / failed_at — populated the moment a decline
--    happens (webhooks/paystack's new charge.failed handler), not up to
--    24h later by cleanup.
-- 2. orders.is_canary — marks synthetic end-to-end test purchases (see the
--    cron 'canary' task) so they're excluded from revenue/summary numbers.
-- 3. support_reports — backs the in-app "Report an issue" button.
--
-- Safe to run against the live DB: idempotent, purely additive.

alter table public.orders add column if not exists failure_reason text;
alter table public.orders add column if not exists failed_at timestamptz;
alter table public.orders add column if not exists is_canary boolean not null default false;

create table if not exists public.support_reports (
  id            uuid default uuid_generate_v4() primary key,
  user_id       uuid references public.profiles(id) on delete set null,
  email         text not null,
  page_url      text,
  message       text not null,
  status        text not null default 'open' check (status in ('open','resolved')),
  created_at    timestamptz default now(),
  resolved_at   timestamptz
);

create index if not exists idx_support_reports_status on public.support_reports(status);

alter table public.support_reports enable row level security;

-- No insert policy for anon/authenticated — the API route always writes
-- through the admin client (same pattern as orders/checkout), same reason
-- 0031's referrals table has no direct-write policy either. These two are
-- read-only policies for users viewing their own submitted reports.
drop policy if exists "User can view own reports" on public.support_reports;
create policy "User can view own reports" on public.support_reports for select
  using (auth.uid() = user_id);

drop policy if exists "Admins can view all reports" on public.support_reports;
create policy "Admins can view all reports" on public.support_reports for select
  using (public.is_admin(auth.uid()));

drop policy if exists "Admins can update reports" on public.support_reports;
create policy "Admins can update reports" on public.support_reports for update
  using (public.is_admin(auth.uid()));

insert into public.schema_migrations (filename) values
  ('0036_payment_alerting_canary_support.sql')
on conflict do nothing;
