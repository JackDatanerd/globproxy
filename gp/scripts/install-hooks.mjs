#!/usr/bin/env node
// Points this clone's git at the repo's .githooks/ directory (a pre-push hook that runs
// the fast offline checks). Run once per clone:  npm run hooks:install
// The same checks run in CI, but a push that is going to fail there is faster to learn about
// locally than after a deploy-queue round trip.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

try {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: top })
  // Git skips a hook that is not executable (macOS / Linux clones); make sure it is.
  const hook = join(top, '.githooks', 'pre-push')
  if (existsSync(hook)) { try { chmodSync(hook, 0o755) } catch { /* Windows: not needed */ } }
  console.log(`[install-hooks] core.hooksPath = .githooks (${top}). Bypass once with: git push --no-verify`)
} catch (e) {
  console.error('[install-hooks] Could not configure git:', e.message)
  process.exit(1)
}
