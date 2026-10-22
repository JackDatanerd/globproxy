-- 0063: Dashboard UI pass
--
-- profiles.low_bandwidth_emails — opt-out for the "your session is 80% / 95%
-- used" e-mails (usageSync's low-bandwidth notice). Default ON, so nobody
-- loses the warning they have today; a customer who drives everything through
-- the API and webhooks can now turn the e-mails off. This covers ONLY that
-- advisory e-mail: the "ran out" notice, security e-mails and receipts are not
-- optional, and webhooks are unaffected (they're opted into per endpoint).

alter table public.profiles
  add column if not exists low_bandwidth_emails boolean not null default true;

insert into public.schema_migrations (filename) values
  ('0063_dashboard_ui_pass.sql')
on conflict do nothing;
