-- 0086: Dashboard UI pass 3
--
-- Configurable "running low" thresholds. The per-session warning used to be fixed at 80% and
-- 95% used (usageSync's low-bandwidth notice, the dashboard banners and the webhook's
-- threshold_pct). A customer who burns through a session in an hour wants the heads-up earlier;
-- one who tops up by hand once a week may want it later.
--
--   profiles.usage_warn_pct    first heads-up   (default 80)
--   profiles.usage_urgent_pct  "about to stop"  (default 95)
--
-- Defaults equal today's behaviour, so nobody's alerts change until they choose to. The
-- ordering rule (warn < urgent) and the bounds live in the database so a direct write from the
-- browser can't store nonsense. proxy_credentials.low_alerted_pct remembers which tier was last
-- announced, so it can no longer be limited to the two fixed values.
--
-- This covers the per-session alerts only: the once-a-day account-balance e-mail keeps its own
-- 80% / 95% tiers.
--
-- Safe to run against the live DB: idempotent.

alter table public.profiles
  add column if not exists usage_warn_pct   smallint not null default 80,
  add column if not exists usage_urgent_pct smallint not null default 95;

alter table public.profiles drop constraint if exists profiles_usage_alert_pcts_valid;
alter table public.profiles
  add constraint profiles_usage_alert_pcts_valid
  check (usage_warn_pct between 50 and 98 and usage_urgent_pct between 51 and 99 and usage_warn_pct < usage_urgent_pct);

alter table public.proxy_credentials drop constraint if exists proxy_credentials_low_alerted_pct_valid;
alter table public.proxy_credentials
  add constraint proxy_credentials_low_alerted_pct_valid
  check (low_alerted_pct is null or low_alerted_pct between 1 and 99);

insert into public.schema_migrations (filename) values
  ('0086_dashboard_ui_pass3.sql')
on conflict do nothing;
