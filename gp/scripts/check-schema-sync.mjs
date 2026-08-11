#!/usr/bin/env node
// Fails (non-zero exit) if supabase/schema.sql's declared "INCLUDES
// MIGRATIONS THROUGH" line doesn't match the actual newest file in
// supabase/migrations/. This exists because schema.sql has drifted
// from the migrations folder before — regenerated in one commit,
// then a new migration landed in the next commit with schema.sql
// left untouched, silently reintroducing a bug the migration had
// just fixed. Wired into CI (see .github/workflows/schema-drift-check.yml)
// so this is a build failure, not something that depends on a human
// remembering.
//
// Usage: node scripts/check-schema-sync.mjs
// Run from the gp/ directory (or anywhere — paths below are relative
// to this script's own location, not the cwd).

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations')
const schemaPath = path.join(repoRoot, 'supabase', 'schema.sql')

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()

if (migrationFiles.length === 0) {
  console.error(`[check-schema-sync] No migration files found in ${migrationsDir} — refusing to pass trivially.`)
  process.exit(1)
}

const newestMigration = migrationFiles[migrationFiles.length - 1]

const schemaSrc = readFileSync(schemaPath, 'utf8')
const manifestMatch = schemaSrc.match(/INCLUDES MIGRATIONS THROUGH:\s*(\S+)/)

if (!manifestMatch) {
  console.error(
    '[check-schema-sync] schema.sql has no "INCLUDES MIGRATIONS THROUGH: <file>" manifest line.\n' +
    'Add one near the top of supabase/schema.sql so drift is machine-checkable.'
  )
  process.exit(1)
}

const declared = manifestMatch[1]

if (declared !== newestMigration) {
  console.error(
    `[check-schema-sync] schema.sql is out of sync with supabase/migrations/.\n\n` +
    `  schema.sql declares: ${declared}\n` +
    `  newest migration is: ${newestMigration}\n\n` +
    `Fold ${newestMigration}'s changes into supabase/schema.sql, then update the\n` +
    `"INCLUDES MIGRATIONS THROUGH:" line at the top of that file to match.`
  )
  process.exit(1)
}

console.log(`[check-schema-sync] OK — schema.sql is in sync through ${newestMigration}`)
