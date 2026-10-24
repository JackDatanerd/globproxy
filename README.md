# GlobProxy

Residential-proxy reselling platform. The application lives in [`gp/`](gp/)
(Next.js + Supabase, deployed to Cloudflare Workers via OpenNext).
CI/CD workflows live in `.github/workflows/` at the repository root.

- `gp/` — the app, its SQL (`gp/supabase/`) and its tooling (`gp/scripts/`)
- `.github/workflows/` — CI (`ci.yml`), schema drift check, deploy (`deploy.yml`)

Day-to-day checks (run from `gp/`): `npm run check` runs the same checks CI does.
See `gp/FIX_PACKAGE_cron-deletion-ops.md` for operational notes on scheduled
tasks, account deletion and the deploy pipeline.
