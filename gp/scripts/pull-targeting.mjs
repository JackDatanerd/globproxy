#!/usr/bin/env node
// Pulls the supplier's targeting export (countries / states / cities / ISPs) into
// upstream-targeting.json — the git-IGNORED source file the generate-*.py scripts read.
// Until now "re-pull it first" was a comment in three scripts and a manual step nobody
// could repeat; this makes it one command:
//
//   UPSTREAM_API_KEY=… UPSTREAM_TARGETING_URL=… npm run pull:targeting
//   python3 scripts/generate-geo-data.py && python3 scripts/generate-asn-data.py && python3 scripts/generate-locations.py
//
// Both values come from the environment on purpose: the endpoint URL is not recorded in
// this repository (readable by more people than our customers' browsers ever see, and the
// supplier must not be named in anything customer-facing), and the key never belongs in a
// file. UPSTREAM_API_KEY is the same value as the app's supplier API key setting. The
// endpoint is NOT verified from here — if the request is refused, check the supplier's
// reseller API documentation for the targeting-options URL and header.
//
// Output is validated (a JSON object with a non-empty `countries` array) and written
// atomically, so a failed pull never clobbers a good file.
import { writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const gpRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(gpRoot, 'upstream-targeting.json')
const url = process.env.UPSTREAM_TARGETING_URL
const key = process.env.UPSTREAM_API_KEY

if (!url || !key) {
  console.error('[pull-targeting] Set UPSTREAM_TARGETING_URL and UPSTREAM_API_KEY in the environment.')
  process.exit(1)
}
if (!/^https:\/\//.test(url)) {
  console.error('[pull-targeting] UPSTREAM_TARGETING_URL must be an https:// URL.')
  process.exit(1)
}

const res = await fetch(url, { headers: { 'Reseller-Api-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) })
if (!res.ok) {
  console.error(`[pull-targeting] The endpoint answered HTTP ${res.status}. Nothing was written.`)
  process.exit(1)
}
let body
try { body = await res.json() } catch { console.error('[pull-targeting] The response was not JSON. Nothing was written.'); process.exit(1) }
// Some responses wrap the payload ({ result: {...} } / { data: {...} }).
const data = Array.isArray(body?.countries) ? body : (body?.result ?? body?.data ?? body)
if (!data || !Array.isArray(data.countries) || data.countries.length === 0) {
  console.error('[pull-targeting] The response has no non-empty "countries" array. Nothing was written.')
  process.exit(1)
}
const tmp = `${OUT}.tmp`
writeFileSync(tmp, JSON.stringify(data))
renameSync(tmp, OUT)
console.log(`[pull-targeting] Wrote ${existsSync(OUT) ? 'upstream-targeting.json' : '?'} — ${data.countries.length} countries.`)
