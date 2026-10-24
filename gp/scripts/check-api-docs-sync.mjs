#!/usr/bin/env node
// Fails (non-zero exit) when the public API and its documentation drift apart.
// For every app/api/v1/**/route.ts and every HTTP method it exports:
//   1. lib/openapi.ts must describe that method on that path, and
//   2. app/docs/api/page.tsx must show it (an <Endpoint method path> block, or a row in
//      one of its tables whose first cell is "METHOD /path").
// This is how /reseller/invitations/:id/remind shipped without a spec entry: the route,
// the docs page and the OpenAPI spec are written by hand in three places.
//
// Escape hatch: DOCS_ONLY_OK / SPEC_ONLY_OK below list routes that are deliberately
// undocumented in one place, each with the reason.
//
// Usage: node scripts/check-api-docs-sync.mjs   (paths are relative to this file)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const v1 = path.join(root, 'app', 'api', 'v1')
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']

// "METHOD /api/v1/path" -> reason it is intentionally missing from one of the two places.
const NOT_IN_DOCS = {
  'GET /api/v1/openapi.json': 'the spec itself; linked from the docs intro',
}
const NOT_IN_SPEC = {
  'GET /api/v1/openapi.json': 'the spec itself',
}

const errors = []
const fail = (m) => errors.push(m)

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (e === 'route.ts') out.push(p)
  }
  return out
}
// "/api/v1/sub-users/[id]/pause" and ".../:id/pause" and ".../{id}/pause" all become ".../:/pause".
const norm = (p) => p.replace(/\[[^\]/]+\]|\{[^}/]+\}|:[A-Za-z_]+/g, ':')

const routes = []
for (const file of walk(v1)) {
  const rel = '/' + path.relative(path.join(root), path.dirname(file)).split(path.sep).join('/')
  const src = readFileSync(file, 'utf8')
  for (const m of METHODS) {
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src) || new RegExp(`export\\s+const\\s+${m}\\b`).test(src)) {
      routes.push({ method: m, route: rel.replace(/^\/app/, ''), key: `${m} ${rel.replace(/^\/app/, '')}` })
    }
  }
}
if (routes.length === 0) { console.error('[check-api-docs-sync] found no v1 routes — refusing to pass trivially.'); process.exit(1) }

// ── OpenAPI: split lib/openapi.ts into path blocks ──
const spec = readFileSync(path.join(root, 'lib', 'openapi.ts'), 'utf8')
const specPaths = new Map() // normalised path -> text of its block
{
  const re = /^\s*'(\/api\/v1[^']*)'\s*:/gm
  const hits = [...spec.matchAll(re)]
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : spec.length
    const k = norm(h[1])
    specPaths.set(k, (specPaths.get(k) ?? '') + spec.slice(h.index, end))
  })
}

// ── Docs: <Endpoint method="X" path="..."> and table rows 'METHOD /path' ──
const docs = readFileSync(path.join(root, 'app', 'docs', 'api', 'page.tsx'), 'utf8')
const docKeys = new Set()
for (const m of docs.matchAll(/<Endpoint\s+method="([A-Z]+)"\s+path="([^"]+)"/g)) docKeys.add(`${m[1]} ${norm(m[2])}`)
for (const m of docs.matchAll(/'((?:GET|POST|PATCH|PUT|DELETE)(?:\s*\/\s*(?:GET|POST|PATCH|PUT|DELETE))*) (\/api\/v1[^' ]*)'/g)) {
  for (const meth of m[1].split('/').map((x) => x.trim())) docKeys.add(`${meth} ${norm(m[2])}`)
}
// Table rows abbreviate the prefix: 'GET /webhooks/:id' (relative to /api/v1).
for (const m of docs.matchAll(/'((?:GET|POST|PATCH|PUT|DELETE)(?:\s*\/\s*(?:GET|POST|PATCH|PUT|DELETE))*) (\/(?!api\/)[^' ]*)'/g)) {
  for (const meth of m[1].split('/').map((x) => x.trim())) docKeys.add(`${meth} ${norm('/api/v1' + m[2])}`)
}

// Prose: <span>POST /sub-users/:id/resume</span> counts, so a method documented inside
// another endpoint's description (resume under pause) is not forced into its own block.
{
  const text = docs.replace(/<[^>]+>/g, ' ').replace(/\{' '\}/g, ' ')
  for (const m of text.matchAll(/\b(GET|POST|PATCH|PUT|DELETE)((?:\s*(?:\/|,|or)\s*(?:GET|POST|PATCH|PUT|DELETE))*)\s+(\/[A-Za-z0-9_\/:.\-]+)/g)) {
    const methods = [m[1], ...(m[2].match(/GET|POST|PATCH|PUT|DELETE/g) ?? [])]
    const p = m[3].startsWith('/api/') ? m[3] : '/api/v1' + m[3]
    for (const meth of methods) docKeys.add(`${meth} ${norm(p)}`)
  }
}

for (const r of routes) {
  const k = norm(r.route)
  if (!(r.key in NOT_IN_SPEC)) {
    const block = specPaths.get(k)
    if (!block) fail(`OpenAPI has no entry for ${r.method} ${r.route}`)
    else if (!new RegExp(`\\b${r.method.toLowerCase()}\\s*:\\s*op\\(`).test(block)) fail(`OpenAPI describes ${r.route} but not its ${r.method} method`)
  }
  if (!(r.key in NOT_IN_DOCS) && !docKeys.has(`${r.method} ${k}`)) fail(`the docs page does not show ${r.method} ${r.route}`)
}
// And the other way round: a spec path with no route behind it is a lie.
const have = new Set(routes.map((r) => norm(r.route)))
for (const k of specPaths.keys()) if (!have.has(k)) fail(`OpenAPI documents ${k} but no route.ts serves it`)

if (errors.length) {
  console.error('[check-api-docs-sync] the API, its OpenAPI spec and the docs page disagree:\n')
  for (const e of errors) console.error(`  - ${e}`)
  console.error('\nUpdate lib/openapi.ts and app/docs/api/page.tsx (or list the route in the allowlists at the top of this script, with a reason).')
  process.exit(1)
}
console.log(`[check-api-docs-sync] OK — ${routes.length} v1 route methods in sync across routes, OpenAPI and docs`)
