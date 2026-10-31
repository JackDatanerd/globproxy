#!/usr/bin/env node
/**
 * Supplier-name ratchet.
 *
 * The upstream supplier must never be visible to customers. This repository
 * (and its history) may be readable by more people than the app's users, so
 * beyond the runtime guard in lib/supplierGuard.ts we also stop the name from
 * SPREADING through the source: every tracked file may mention it no more
 * often than the committed baseline (scripts/supplier-leak-baseline.json)
 * allows, and a file that is not in the baseline may not mention it at all.
 *
 *   node scripts/check-supplier-leak.mjs           # check (CI / npm run check)
 *   node scripts/check-supplier-leak.mjs --update  # rewrite the baseline —
 *                                                  # only after REMOVING mentions
 *
 * The baseline can only ever shrink: --update refuses to raise any count.
 * SQL is scanned too: the repository can be read by more people than the app's users, and a
 * migration is as readable as source. Migrations that must still touch a legacy identifier build
 * it at run time (chr(103) || 'eonode_…'), as 0050 does.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const gpRoot = resolve(here, '..')
const baselinePath = resolve(here, 'supplier-leak-baseline.json')
// `*` is in the class so a glob such as a .gitignore pattern spelling the name is caught too.
const NAME = /geo[\s_.\-*]*node/gi
const SKIP = [/package-lock\.json$/, /supplier-leak-baseline\.json$/, /scripts\/check-supplier-leak\.mjs$/, /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|gz)$/i]

// The whole repository, not just gp/: the workflows, hooks and README at the root are as
// readable as the source. Keys stay relative to gp/ for files inside it (the baseline's
// existing form) and to the repository root for everything else.
const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: gpRoot, encoding: 'utf8' }).trim()
const files = execFileSync('git', ['ls-files', '-z'], { cwd: top, encoding: 'utf8' }).split('\0').filter(Boolean)
const counts = {}
for (const f of files) {
  if (SKIP.some((re) => re.test(f))) continue
  let text
  try { text = readFileSync(resolve(top, f), 'utf8') } catch { continue }
  const n = (text.match(NAME) ?? []).length
  const key = f.startsWith('gp/') ? f.slice(3) : f
  if (n) counts[key] = n
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}

if (process.argv.includes('--update')) {
  const raised = Object.keys(counts).filter((f) => counts[f] > (baseline[f] ?? (Object.keys(baseline).length ? 0 : Infinity)))
  if (raised.length && Object.keys(baseline).length) {
    console.error('Refusing to update: these files mention the supplier MORE than the baseline allows:\n  ' + raised.join('\n  '))
    process.exit(1)
  }
  writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2) + '\n')
  console.log(`Baseline written: ${Object.keys(counts).length} files.`)
  process.exit(0)
}

const problems = []
for (const [f, n] of Object.entries(counts)) {
  const allowed = baseline[f] ?? 0
  if (n > allowed) problems.push(`${f}: ${n} mention(s), baseline allows ${allowed}`)
}
if (problems.length) {
  console.error('Supplier name is spreading through the source:\n  ' + problems.join('\n  ') +
    '\nUse neutral wording ("upstream", "provider") — see lib/supplierGuard.ts.')
  process.exit(1)
}
const shrunk = Object.keys(baseline).filter((f) => (counts[f] ?? 0) < baseline[f])
console.log(`Supplier-leak ratchet OK (${Object.keys(counts).length} files within baseline${shrunk.length ? `; ${shrunk.length} can be tightened with --update` : ''}).`)
