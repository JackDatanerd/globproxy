#!/usr/bin/env node
// Folds migrations into supabase/schema.sql the way every earlier one was folded, and
// bumps the "INCLUDES MIGRATIONS THROUGH" line — the step check-schema-sync.mjs fails
// the build for, which used to be done by hand (pasting a file under a banner and
// editing the manifest) and was the most common reason a push went red.
//
//   node scripts/fold-migration.mjs            # fold every migration newer than the manifest
//   node scripts/fold-migration.mjs --check    # report what would be folded, change nothing
//
// A migration is appended verbatim under a banner; the migration's own trailing
// `insert into schema_migrations` stays (a fresh database built from schema.sql must
// record it too). Re-running folds nothing.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migDir = join(root, 'supabase', 'migrations')
const schemaPath = join(root, 'supabase', 'schema.sql')
const checkOnly = process.argv.includes('--check')

let schema = readFileSync(schemaPath, 'utf8')
const m = schema.match(/INCLUDES MIGRATIONS THROUGH:\s*(\S+)/)
if (!m) { console.error('[fold-migration] schema.sql has no "INCLUDES MIGRATIONS THROUGH:" line.'); process.exit(1) }
const current = m[1]
const files = readdirSync(migDir).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort()
if (!files.includes(current)) { console.error(`[fold-migration] The manifest names ${current}, which is not in supabase/migrations/.`); process.exit(1) }
const todo = files.filter((f) => f > current)
if (todo.length === 0) { console.log(`[fold-migration] Nothing to fold — schema.sql already includes ${current}.`); process.exit(0) }

for (const f of todo) {
  if (schema.includes(`-- ${f} (folded)`)) { console.error(`[fold-migration] ${f} already has a folded banner in schema.sql — fix the manifest by hand.`); process.exit(1) }
}
if (checkOnly) { console.log('[fold-migration] Would fold:\n  ' + todo.join('\n  ')); process.exit(0) }

for (const f of todo) {
  const body = readFileSync(join(migDir, f), 'utf8').replace(/\s+$/, '')
  schema = schema.replace(/\s*$/, '\n') + `\n-- ============================================================\n-- ${f} (folded)\n-- ============================================================\n${body}\n`
  console.log(`[fold-migration] folded ${f}`)
}
schema = schema.replace(/(INCLUDES MIGRATIONS THROUGH:\s*)\S+/, `$1${todo[todo.length - 1]}`)
writeFileSync(schemaPath, schema)
console.log(`[fold-migration] Manifest now reads ${todo[todo.length - 1]}. Run: npm run check:schema`)
