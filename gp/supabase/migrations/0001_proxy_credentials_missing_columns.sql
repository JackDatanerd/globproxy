-- Fixes: proxy_credentials was missing columns that app code has been
-- inserting/updating into since at least the dashboard/proxies and
-- bandwidth-activation code paths were written. Any insert/update touching
-- these columns fails at the DB layer (PGRST204 "column not found in schema
-- cache"), which is why credential creation and post-payment activation
-- have not been reliably persisting real Geonode credentials.
--
-- Safe to run against the live DB as-is: every change is guarded so it can
-- be re-run without erroring if partially applied already.

alter table public.proxy_credentials
  add column if not exists geonode_sub_user_id text,
  add column if not exists protocol           text default 'http' check (protocol in ('http','socks5')),
  add column if not exists sticky_duration     integer,
  add column if not exists endpoint_count      integer default 1,
  add column if not exists asn                 text;

comment on column public.proxy_credentials.asn is
  'Geonode ASN/ISP targeting number (e.g. 13868) — appended to username after city, before lifetime/session. Free text since we don''t have Geonode''s full ASN-to-ISP-name mapping.';
