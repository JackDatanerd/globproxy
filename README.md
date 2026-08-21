# GlobProxy — automate IndexNow into the deploy workflow

## What this changes

One file, one added step: `.github/workflows/deploy.yml` — after the existing
"Deploy to Cloudflare Workers" step, added a "Notify IndexNow (Bing/Yandex) of
current sitemap" step that runs `npm run indexnow` (the script from the last
package).

**Note the file location**: `.github/workflows/` lives at the repo root, not
inside `gp/` — confirmed this from the existing file's own comment
("Must live at .github/workflows/ at the repo root, not inside gp/ — same as
the cron workflows"), and by finding it there in your actual repo structure.
So this one extracts to the repo root, not into `gp/`.

## Behavior

- Only runs if the deploy step before it succeeds — normal sequential GitHub
  Actions step behavior, nothing special configured for that part.
- `continue-on-error: true` on this step specifically: if IndexNow's API has
  a transient outage or errors, that shouldn't mark your whole deploy run as
  failed and alarm you — the deploy itself (the part that actually matters)
  already succeeded by the time this step runs. The step still logs its own
  pass/fail clearly in the Actions run output either way, so you'll see if
  it's failing repeatedly, it just won't block or red-flag the pipeline.
- No new secrets, no new permissions, no changes to the `check-schema` job
  or anything before the existing deploy step.

## Requires

The previous IndexNow package (`globproxy-indexnow.tar.gz`) needs to already
be merged and deployed — this step calls `npm run indexnow`, which only
exists because that package added it to `package.json`. If you haven't
deployed that one yet, this step will fail with "missing script: indexnow".

## Apply

```bash
cd C:\Users\jackk\Desktop\MyWebApps\globproxy
tar -xzf ~/Downloads/globproxy-indexnow-ci.tar.gz -C .
git add .github/workflows/deploy.yml
git commit -m "ci: auto-notify IndexNow after every successful deploy"
git push origin main
```

Run this from the **repo root** (`globproxy`), not from `gp/` — that's where
`.github/` lives, same as the existing workflow files.

## After it's deployed

Push anything to `main` (or just watch the next real deploy) and check the
Actions run — you should see the new "Notify IndexNow" step run and log
`Done — IndexNow responded 202` right after the Cloudflare deploy step. From
here on, every deploy automatically re-notifies Bing/Yandex of your current
sitemap — nothing left to run by hand.
