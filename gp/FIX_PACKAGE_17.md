# Fix Package 17 — real migration tracking

## What this closes

`check-schema-sync.mjs` (existing CI check) only ever compares two text
files to each other — `schema.sql`'s manifest line against the newest
filename in `supabase/migrations/`. It has no way to know whether a
migration was ever actually *run*. That's exactly the gap `0022` fell
through: correctly committed, correctly reflected in `schema.sql`, CI
green the whole time — and simply never executed against the live
database. Every signal available said "fine" while production silently
disagreed. Nothing before this could have caught it.

## What's new

**`public.schema_migrations`** — a table that records, as fact, which
migrations have actually been applied to a given database. Migration
`0027` creates it and backfills every migration through itself
(`0001`–`0027`) as already-applied, since all of them (including the
now-fixed `0022`) are confirmed applied as of your last check.

**Convention going forward:** every new migration file ends with:

```sql
insert into public.schema_migrations (filename) values
  ('00NN_your_migration_name.sql')
on conflict (filename) do nothing;
```

The `on conflict do nothing` makes re-running an already-applied migration
harmless — consistent with how the rest of your migrations are already
written (`add column if not exists`, `create or replace function`, etc.).

**`scripts/check-migrations-applied.mjs`** — the actual verification
step. Reads `supabase/migrations/` on disk, reads `schema_migrations`
from the live database (via the same service-role credentials the app
itself uses), and fails loudly listing anything on disk that isn't
recorded as applied. Run it any time you want a real answer to "is this
database caught up," instead of trusting that CI being green means so.

```
node scripts/check-migrations-applied.mjs
```

Needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the
environment — same variables the app already reads, so if you run it
from a shell that's sourced `.env.local` it just works.

## What I deliberately did NOT do

I didn't drop a GitHub Actions workflow into `.github/workflows/` that
runs this automatically. That would need `SUPABASE_SERVICE_ROLE_KEY` — a
production credential — sitting in a repo secret, and I don't think
that's my call to make unilaterally. If you want it wired into CI
(e.g. nightly, or on every push to `main`), here's the workflow — add it
yourself once you've added the secret under repo Settings → Secrets:

```yaml
name: migrations-applied-check
on:
  schedule:
    - cron: '0 6 * * *'   # daily, adjust as you like
  workflow_dispatch: {}
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
        working-directory: gp
      - run: node scripts/check-migrations-applied.mjs
        working-directory: gp
        env:
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
```

Worth weighing: this is the same class of secret that, mangled via the
dashboard, caused real problems before — if you do add it as a GH secret,
paste it directly (GitHub's secret UI doesn't mangle values the way
Cloudflare's has), and treat it with the same care as any other
production credential living in CI.

## Files changed

- `supabase/migrations/0027_migration_tracking.sql` (new)
- `supabase/schema.sql`
- `scripts/check-migrations-applied.mjs` (new)

## To apply

```
cd C:\Users\jackk\Desktop\MyWebApps\globproxy\gp
tar -xzf ~/Downloads/globproxy-fixes-17.tar.gz --strip-components=1 -C .
git add -A
git commit -m "feat: real migration tracking — schema_migrations table + check-migrations-applied.mjs"
git push
```

Then run `0027_migration_tracking.sql` against Supabase — same as any
other migration. After that, `node scripts/check-migrations-applied.mjs`
is your on-demand "is production actually caught up" answer, any time you
want it, without guessing.
