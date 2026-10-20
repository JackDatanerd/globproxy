-- 0049: Dashboard UI close-out.
-- last_provision_error is readable by the owning customer (SELECT on
-- proxy_credentials). Older rows could hold raw upstream-supplier error text.
-- Application code now writes only neutral codes; scrub what already exists.
update public.proxy_credentials
   set last_provision_error = 'provision_failed'
 where last_provision_error is not null
   and last_provision_error !~ '^(provision_failed|upstream_error_[0-9]+)$';

insert into public.schema_migrations (filename) values
  ('0049_dashboard_ui_closeout.sql')
on conflict do nothing;
