-- ============================================================
-- 0032 — Network benchmarks (public /status page)
-- ============================================================
-- Backing table for a public, unauthenticated page showing measured
-- success rate / latency for GlobProxy's pool against a small set of
-- reachability targets. Rows are written by admins (see
-- /api/admin/record-benchmark) and, once the cron 'benchmark' task is
-- wired up to a real network probe, by that cron task via the admin
-- client — either way, service_role only. The SELECT policy below is
-- deliberately public: the entire point of this table is a page anyone
-- (a prospective customer checking us out on a forum thread, a current
-- customer, an existing user) can load without an account.
--
-- Safe to run against the live DB: idempotent (IF NOT EXISTS), purely
-- additive.

create table if not exists public.network_benchmarks (
  id             uuid default uuid_generate_v4() primary key,
  target_label   text not null, -- human-readable name of what was tested, e.g. "General reachability"
  success_rate   numeric not null check (success_rate >= 0 and success_rate <= 100),
  avg_latency_ms numeric,
  sample_size    integer not null default 0 check (sample_size >= 0),
  measured_at    timestamp with time zone not null default now(),
  notes          text,
  created_at     timestamp with time zone not null default now()
);

create index if not exists idx_network_benchmarks_target_measured
  on public.network_benchmarks(target_label, measured_at desc);

alter table public.network_benchmarks enable row level security;

drop policy if exists "Anyone can view benchmarks" on public.network_benchmarks;
create policy "Anyone can view benchmarks" on public.network_benchmarks for select
  using (true);

-- No insert/update/delete policy for anon/authenticated — every write
-- goes through the admin (service-role) client, same posture as every
-- other admin-authored table in this schema.

insert into public.schema_migrations (filename) values
  ('0032_network_benchmarks.sql')
on conflict do nothing;
