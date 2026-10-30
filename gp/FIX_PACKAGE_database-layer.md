# Fix package — Section 10 Database layer (independent pass, Oct 2026)

Run `supabase/migrations/0112_database_layer_closeout.sql` in the Supabase SQL editor (idempotent). It is already folded into `schema.sql`.

How it was found: `schema.sql`, and the pre-0001 baseline plus all migrations, were built as two real databases and their catalogs diffed (now `npm run check:db`).

## Bugs
- `profiles.marketing_emails`: the column-level SELECT grant from 0108 was missing from `schema.sql`. A database built from it could not read the column, so the settings toggle showed "on" for customers who had opted out. Production was fine.
- `schema.sql` recorded 72 of 111 migrations (0001–0038 and 0046 missing); `check-migrations-applied` failed on a `schema.sql` database. Backfilled.
- The default-privilege "safety net" from 0012 never worked: a schema-scoped REVOKE cannot remove PUBLIC's EXECUTE on new functions, so the next function added without its own REVOKE shipped callable by anon via /rpc. Now revoked globally. `admin_audit_log_guard`, `record_affiliate_rate_change` and `is_admin` were still client-executable; closed (triggers still fire; `is_admin` still runs inside the protect trigger as owner).
- `profiles` UPDATE was a denylist trigger over a table-wide grant, so `created_at`, `updated_at`, the three `*_application` columns, `billing_address`, `tax_id` and any future column were user-writable. UPDATE is now an allowlist of the six columns the browser writes (`full_name`, `company_name`, `low_bandwidth_emails`, `marketing_emails`, `usage_warn_pct`, `usage_urgent_pct`). INSERT / DELETE / TRUNCATE revoked. The trigger stays as a second layer. Behaviour change: a browser write to any other column now fails with permission denied instead of being silently reverted.
- Constraint names on `profiles` differed between a `schema.sql` database and a migrated one; aligned to the migrated names.
- `return_reseller_stock_on_client_delete` read each transfer's remaining GB unlocked and took locks in the opposite order to `reclaim_reseller_allocation`: a concurrent reclaim could be double-counted (stock over-returned) or deadlock. It now locks the transfer row first, re-reads it, then the accounts.

## Guards added
- `scripts/check-db-parity.mjs` (`npm run check:db`, CI step in `schema-drift-check.yml`): diffs the two databases (tables, columns and column privileges, constraints, indexes, triggers, policies, function bodies and EXECUTE grants, default privileges, seed rows) and asserts: no client-executable function, a function created later is not client-executable, RLS on every table, every SECURITY DEFINER function pins `search_path`, profile UPDATE is exactly the allowlist. Fails on the pre-fix tree with 27 problems.
- Needs `@electric-sql/pglite@0.5.10` (pinned, not a project dependency): `npm install --prefix scripts --no-save --no-package-lock --ignore-scripts @electric-sql/pglite@0.5.10`.
- `supabase/baseline/pre-0001-schema.sql`: the schema the migrations were written against.
- `tests/database-layer-pass.test.mjs`: fails if the browser ever writes a profile column outside the allowlist, or the wiring above rots.

## Not changed
- An index created before a column rename still carries the old column name in its internal metadata (migration-built databases only). It is not exposed through the API.
