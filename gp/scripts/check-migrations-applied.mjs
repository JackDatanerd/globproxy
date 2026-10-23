#!/usr/bin/env node
// Fails (non-zero exit) if the LIVE database is missing any migration
// that exists in supabase/migrations/ on disk.
//
// This is a different check from check-schema-sync.mjs, which only
// compares two text files to each other and has no way to know whether
// a migration was ever actually run. This one asks the database itself,
// via the public.schema_migrations table (see migration 0027) that every
// migration records itself into as its last statement.
//
// This is how 0022 was found to have been silently unapplied in
// production for an unknown period — nothing before this script could
// have caught it; check-schema-sync.mjs was green the whole time.
//
// Wired into .github/workflows/deploy.yml as a gate before the build (and runnable by
// hand as `npm run check:migrations`): code that calls an RPC or column from a
// migration must not reach production before that migration has been applied.
//
// Usage: node scripts/check-migrations-applied.mjs
// Requires env vars (same ones the app itself uses):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Run locally with `.env.local` loaded, or point at whichever
// environment you want to verify (staging vs. production) by swapping
// which env file/values you export first.

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(scriptDir, '..', 'supabase', 'migrations')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('[check-migrations-applied] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.')
  console.error('Load them the same way the app does (.env.local) before running this.')
  process.exit(1)
}

const onDisk = readdirSync(migrationsDir)
  .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
  .sort()

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

const { data, error } = await supabase.from('schema_migrations').select('filename')

if (error) {
  console.error('[check-migrations-applied] Could not read public.schema_migrations from the live database:')
  console.error(error)
  console.error('If this table does not exist yet, migration 0027_migration_tracking.sql itself has not been run — run that first.')
  process.exit(1)
}

const applied = new Set(data.map((r) => r.filename))
const missing = onDisk.filter((f) => !applied.has(f))
const extra = [...applied].filter((f) => !onDisk.includes(f)).sort()

if (missing.length > 0) {
  console.error(`[check-migrations-applied] ${missing.length} migration(s) on disk have NOT been recorded as applied to this database:`)
  for (const f of missing) console.error(`  - ${f}`)
  console.error('')
  console.error('Run these against the database (SQL Editor or your usual path), in order.')
  process.exit(1)
}

if (extra.length > 0) {
  // Not a failure on its own — could be a migration that was later
  // deleted/renamed, or a different branch's migrations applied to a
  // shared environment — but worth a human looking at it.
  console.warn(`[check-migrations-applied] Note: ${extra.length} filename(s) are recorded as applied but no longer exist on disk:`)
  for (const f of extra) console.warn(`  - ${f}`)
}

console.log(`[check-migrations-applied] OK — all ${onDisk.length} migrations on disk are recorded as applied.`)
