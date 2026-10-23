#!/usr/bin/env node
// Fails (non-zero exit) if supabase/schema.sql is not a faithful roll-up of
// supabase/migrations/. Three checks:
//
//  1. MANIFEST — schema.sql's "INCLUDES MIGRATIONS THROUGH" line names the newest
//     migration. (This is all the script used to check, and it is easy to satisfy
//     without doing the work: 0053 was never folded in and 0054's fold was cut off
//     mid-banner while the line still read "through 0066".)
//  2. CONTENT — every table, function, column, index, trigger and policy a
//     migration (0027 onward) creates must exist somewhere in schema.sql, unless a
//     LATER migration drops it. Comments are ignored. A fresh database built from
//     schema.sql would otherwise silently lack them.
//  3. NUMBERING — migration files are named NNNN_*.sql with no duplicate and no
//     missing number (two sessions picking the same number is how renumbering
//     comments end up in schema.sql).
//
// Usage: node scripts/check-schema-sync.mjs   (paths are relative to this file)

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations')
const schemaPath = path.join(repoRoot, 'supabase', 'schema.sql')
const FIRST_CHECKED = 27 // 0001-0026 predate migration tracking and were folded wholesale

const errors = []
const fail = (m) => errors.push(m)

const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
if (migrationFiles.length === 0) {
  console.error(`[check-schema-sync] No migration files found in ${migrationsDir} — refusing to pass trivially.`)
  process.exit(1)
}
for (const f of migrationFiles) if (!/^\d{4}_[\w-]+\.sql$/.test(f)) fail(`migration file "${f}" does not match NNNN_name.sql`)

// ── numbering ──
const numbers = migrationFiles.map((f) => Number(f.slice(0, 4))).filter(Number.isFinite)
const seen = new Set()
for (const n of numbers) { if (seen.has(n)) fail(`two migrations share the number ${String(n).padStart(4, '0')}`); seen.add(n) }
for (let n = numbers[0] + 1; n <= numbers[numbers.length - 1]; n++) {
  if (!seen.has(n)) fail(`migration number ${String(n).padStart(4, '0')} is missing (gap in the sequence)`)
}

const newestMigration = migrationFiles[migrationFiles.length - 1]
const schemaSrc = readFileSync(schemaPath, 'utf8')

// ── manifest ──
const manifestMatch = schemaSrc.match(/INCLUDES MIGRATIONS THROUGH:\s*(\S+)/)
if (!manifestMatch) {
  fail('schema.sql has no "INCLUDES MIGRATIONS THROUGH: <file>" manifest line.')
} else if (manifestMatch[1] !== newestMigration) {
  fail(`schema.sql declares "${manifestMatch[1]}" but the newest migration is "${newestMigration}". ` +
       `Fold ${newestMigration} into supabase/schema.sql, then update the manifest line.`)
}

// ── content ──
const strip = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
const norm = (sql) => strip(sql).replace(/\s+/g, ' ').toLowerCase()
const S = norm(schemaSrc)
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function objectsOf(t) {
  const out = []
  for (const m of t.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)/g)) out.push(['table', m[1]])
  for (const m of t.matchAll(/create (?:or replace )?function (?:public\.)?(\w+)/g)) out.push(['function', m[1]])
  for (const m of t.matchAll(/add column (?:if not exists )?(\w+)/g)) out.push(['column', m[1]])
  for (const m of t.matchAll(/create (?:unique )?index (?:concurrently )?(?:if not exists )?(\w+)/g)) out.push(['index', m[1]])
  for (const m of t.matchAll(/create trigger (\w+)/g)) out.push(['trigger', m[1]])
  for (const m of t.matchAll(/create policy "([^"]+)"/g)) out.push(['policy', m[1]])
  return out
}
function droppedBy(t) {
  const d = new Set()
  for (const m of t.matchAll(/drop (?:table|index|function|trigger|policy|column)(?: if exists)? (?:public\.)?"?(\w[\w ]*?)"?(?: on |\(|;| cascade| restrict|$)/g)) d.add(m[1].trim())
  for (const m of t.matchAll(/drop column (?:if exists )?(\w+)/g)) d.add(m[1])
  // A rename supersedes the old name (e.g. 0050 renames an index created by 0040).
  for (const m of t.matchAll(/alter index (?:if exists )?(?:public\.)?(\w+) rename to/g)) d.add(m[1])
  for (const m of t.matchAll(/rename column (\w+) to/g)) d.add(m[1])
  for (const m of t.matchAll(/alter table (?:if exists )?(?:public\.)?(\w+) rename to/g)) d.add(m[1])
  return d
}
function presentInSchema(kind, name) {
  const n = esc(name.toLowerCase())
  if (kind === 'function') return new RegExp(`function (?:public\\.)?${n}\\b`).test(S)
  if (kind === 'table') return new RegExp(`table (?:if not exists )?(?:public\\.)?${n}\\b`).test(S)
  if (kind === 'policy') return S.includes(`"${name.toLowerCase()}"`)
  return new RegExp(`\\b${n}\\b`).test(S)
}

const texts = new Map(migrationFiles.map((f) => [f, norm(readFileSync(path.join(migrationsDir, f), 'utf8'))]))
for (let i = 0; i < migrationFiles.length; i++) {
  const f = migrationFiles[i]
  if (Number(f.slice(0, 4)) < FIRST_CHECKED) continue
  const later = new Set()
  for (const g of migrationFiles.slice(i + 1)) for (const d of droppedBy(texts.get(g))) later.add(d)
  const missing = [...new Set(objectsOf(texts.get(f)).map(([k, n]) => `${k}:${n}`))]
    .filter((x) => { const [k, n] = [x.slice(0, x.indexOf(':')), x.slice(x.indexOf(':') + 1)]; return !later.has(n) && !presentInSchema(k, n) })
  if (missing.length) fail(`schema.sql is missing what ${f} creates: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` (+${missing.length - 12} more)` : ''}`)
}

if (errors.length) {
  console.error('[check-schema-sync] schema.sql is NOT a faithful roll-up of supabase/migrations/:\n')
  for (const e of errors) console.error(`  - ${e}`)
  console.error('\nFold the missing migration content into supabase/schema.sql (in migration order), then update the manifest line.')
  process.exit(1)
}
console.log(`[check-schema-sync] OK — ${migrationFiles.length} migrations, schema.sql in sync through ${newestMigration}`)
