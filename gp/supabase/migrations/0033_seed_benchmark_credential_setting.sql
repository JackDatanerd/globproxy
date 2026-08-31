-- ============================================================
-- 0033 — Seed benchmark_credential_id platform setting
-- ============================================================
-- Empty by default — the 'benchmark' cron task (see app/api/cron/
-- [task]/route.ts) treats an empty value the same as an absent row and
-- skips cleanly. Set this to the id of a dedicated "house" proxy_credentials
-- row (protocol='http', status='active') once one exists, e.g.:
--   update public.platform_settings set value = '<uuid>' where key = 'benchmark_credential_id';

insert into public.platform_settings (key, value) values
  ('benchmark_credential_id', '')
on conflict (key) do nothing;

insert into public.schema_migrations (filename) values
  ('0033_seed_benchmark_credential_setting.sql')
on conflict do nothing;
