# Fix Package 13 — deploy/drift-check gating

## What was wrong

`.github/workflows/deploy.yml` and `.github/workflows/schema-drift-check.yml`
both trigger on push to `main`, but as two separate workflow files they run
independently — GitHub Actions gives no ordering guarantee between them. A
push containing a new migration without a matching `schema.sql` update would
still deploy successfully, even while the drift check failed in its own
parallel run. The check existed but nothing stopped on its failure.

## Fix

`deploy.yml` now runs the same schema check as its own `check-schema` job,
and the `deploy` job declares `needs: check-schema`. This makes the gate
structural — deploy cannot start until the check passes, in the same
workflow run, with no dependency on branch-protection settings (which only
gate PR merges, not direct pushes) and no race condition.

`schema-drift-check.yml` is left as-is and kept for a different purpose:
it also runs on `pull_request`, giving fast feedback in the PR view before
merge. The two are now complementary — PR-time visibility vs. the actual
deploy-time gate — not redundant.

## File changed

- `.github/workflows/deploy.yml`

## To apply

```
tar xzf globproxy-fixes-13.tar.gz
git add -A
git commit -m "ci: gate deploy on schema-drift check via needs:, not a separate unlinked workflow"
git push
```
