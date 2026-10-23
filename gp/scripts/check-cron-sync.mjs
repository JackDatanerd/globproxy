#!/usr/bin/env node
// Fails the build when the Worker's moving parts have drifted apart:
//
//   wrangler.jsonc triggers.crons   <->  custom-worker.ts CRON_TASKS keys
//   CRON_TASKS task names           <->  KNOWN in app/api/cron/[task]/route.ts
//   INDEPENDENT_CHAINS              ⊂    CRON_TASKS keys
//   wrangler.jsonc ratelimits       <->  RATE_LIMITER_BINDINGS in lib/rateLimit.ts
//
// Each of those was only ever kept in step by a comment saying "keep in sync". A
// mismatch is silent at runtime: a cron pattern with no mapping logs one line and
// runs nothing; a mapped pattern Cloudflare never fires never runs; a task name the
// route does not know answers 400 every tick; a dropped rate-limit binding turns
// that limiter off (/api/health notices, but only after it is live).
//
// Run by `npm run build:cf` (so by deploy.yml) and `npm run check:cron`.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const errors = []
const warnings = []

// JSONC -> JSON, string-aware (so a "//" inside a string survives).
function parseJsonc(src) {
  let out = ''
  let inStr = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      out += c
      if (c === '\\') { out += src[++i] ?? '' } else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const wrangler = parseJsonc(read('wrangler.jsonc'))
const worker = read('custom-worker.ts')
const route = read('app/api/cron/[task]/route.ts')
const limiterSrc = read('lib/rateLimit.ts')

// ── crons ──────────────────────────────────────────────────────────
const wranglerCrons = new Set(wrangler?.triggers?.crons ?? [])

const mapBlock = worker.match(/const CRON_TASKS\s*:[^=]*=\s*\{([\s\S]*?)\n\}/)
if (!mapBlock) errors.push('could not find the CRON_TASKS map in custom-worker.ts')
const cronMap = new Map()
for (const m of (mapBlock?.[1] ?? '').matchAll(/^\s*'([^']+)'\s*:\s*\[([^\]]*)\]/gm)) {
  cronMap.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]))
}
if (mapBlock && cronMap.size === 0) errors.push('CRON_TASKS in custom-worker.ts parsed to zero entries')

for (const c of wranglerCrons) if (!cronMap.has(c)) errors.push(`wrangler.jsonc schedules "${c}" but custom-worker.ts CRON_TASKS has no entry for it — it would fire and run nothing`)
for (const c of cronMap.keys()) if (!wranglerCrons.has(c)) errors.push(`custom-worker.ts maps "${c}" but wrangler.jsonc triggers.crons does not schedule it — it would never run`)
for (const c of [...wranglerCrons, ...cronMap.keys()]) if (c.trim().split(/\s+/).length !== 5) errors.push(`"${c}" is not a 5-field cron expression`)

// ── task names ─────────────────────────────────────────────────────
const knownBlock = route.match(/const KNOWN\s*=\s*\[([^\]]*)\]/)
if (!knownBlock) errors.push('could not find the KNOWN task list in app/api/cron/[task]/route.ts')
const known = new Set([...(knownBlock?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]))
const scheduled = new Set()
for (const [cron, tasks] of cronMap) {
  for (const t of tasks) {
    scheduled.add(t)
    if (!known.has(t)) errors.push(`"${cron}" runs task "${t}", which the cron route does not know — every tick would answer 400`)
  }
}
for (const t of known) if (!scheduled.has(t)) warnings.push(`task "${t}" is in the cron route but no schedule runs it (fine only if it is manual-only)`)

// ── heartbeat windows ──────────────────────────────────────────────
// lib/cronHealth.ts CRON_MAX_AGE_SECONDS names tasks that must run within a window.
// A name that is not a scheduled task would be reported "stopped" forever; a
// scheduled task missing from it is never noticed when it stops (stock and usage
// are watched by their own dedicated checks).
const healthSrc = read('lib/cronHealth.ts')
const ageBlock = healthSrc.match(/export const CRON_MAX_AGE_SECONDS[^=]*=\s*\{([\s\S]*?)\n\}/)
if (!ageBlock) errors.push('could not find CRON_MAX_AGE_SECONDS in lib/cronHealth.ts')
const watched = new Set([...(ageBlock?.[1] ?? '').matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]))
for (const t of watched) if (!scheduled.has(t)) errors.push(`lib/cronHealth.ts CRON_MAX_AGE_SECONDS watches "${t}", which no schedule runs — it would be reported stopped forever`)
for (const t of scheduled) if (!watched.has(t) && t !== 'stock' && t !== 'usage') warnings.push(`scheduled task "${t}" has no CRON_MAX_AGE_SECONDS entry, so nothing notices if it stops`)

// ── independent chains ─────────────────────────────────────────────
const indep = worker.match(/const INDEPENDENT_CHAINS\s*=\s*new Set\(\[([^\]]*)\]\)/)
if (!indep) errors.push('could not find INDEPENDENT_CHAINS in custom-worker.ts')
for (const m of (indep?.[1] ?? '').matchAll(/'([^']+)'/g)) {
  if (!cronMap.has(m[1])) errors.push(`INDEPENDENT_CHAINS lists "${m[1]}", which is not a CRON_TASKS pattern`)
}

// ── rate-limit bindings ────────────────────────────────────────────
const declared = new Set((wrangler.ratelimits ?? []).map((b) => b.name))
const listBlock = limiterSrc.match(/export const RATE_LIMITER_BINDINGS[^=]*=\s*\[([\s\S]*?)\n\]/)
if (!listBlock) errors.push('could not find RATE_LIMITER_BINDINGS in lib/rateLimit.ts')
const expected = new Set([...(listBlock?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]))
for (const n of expected) if (!declared.has(n)) errors.push(`lib/rateLimit.ts expects the rate-limit binding ${n} but wrangler.jsonc "ratelimits" does not declare it — that limiter would silently allow everything`)
for (const n of declared) if (!expected.has(n)) warnings.push(`wrangler.jsonc declares the rate-limit binding ${n}, which RATE_LIMITER_BINDINGS (the /api/health check) does not list`)
const ids = (wrangler.ratelimits ?? []).map((b) => String(b.namespace_id))
for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) errors.push(`rate-limit namespace_id ${id} is used by more than one binding — they would share one counter`)
if (wrangler.unsafe?.bindings?.some?.((b) => b.type === 'ratelimit')) errors.push('rate-limit bindings are declared under unsafe.bindings; use the stable top-level "ratelimits" key')

for (const w of warnings) console.warn(`check-cron-sync: warning: ${w}`)
if (errors.length) {
  for (const e of errors) console.error(`check-cron-sync: ERROR: ${e}`)
  process.exit(1)
}
console.log(`check-cron-sync: ok (${wranglerCrons.size} schedules, ${scheduled.size} tasks, ${declared.size} rate-limit bindings)`)
