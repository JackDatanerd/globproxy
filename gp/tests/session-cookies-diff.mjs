// Helper for tests/session-cookies.test.mjs (not a test itself: the runner only picks up
// *.test.mjs). Builds random cookie jars and compares lib/sessionCookies.ts with what the real
// @supabase/ssr + auth-js client does with them. Prints one JSON line.
import { createServerClient } from '@supabase/ssr'
import { brokenSessionCookieNames, withoutBrokenSessionCookies } from '../lib/sessionCookies.ts'

process.on('unhandledRejection', () => {}) // the library leaves a rejected initial-session promise behind

const REF = 'abcdref'
const K = `sb-${REF}-auth-token`
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url')
const NOW = Math.floor(Date.now() / 1000)
const sessionJson = () => JSON.stringify({ access_token: 'GOOD.x.y', refresh_token: 'r', expires_at: NOW + 3000, token_type: 'bearer', user: { id: 'u1' } })
const good = 'base64-' + b64url(sessionJson())
const pieces = [
  good, 'zzz', '', 'base64-!!!', 'base64-' + Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'),
  'base64-' + b64url('"s"'), good + '==', encodeURIComponent(sessionJson()),
  good.slice(0, 60), good.slice(60), good.slice(0, 40) + ' ' + good.slice(40),
]
const names = [K, `${K}.0`, `${K}.1`, `${K}.2`]
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const fetchStub = async () => new Response(JSON.stringify({ message: 'x' }), { status: 401, headers: { 'content-type': 'application/json' } })
const client = (list) => createServerClient(`https://${REF}.supabase.co`, 'anon', { cookies: { getAll: () => list, setAll() {} }, global: { fetch: fetchStub } })

const mismatches = []
let broken = 0
const total = 600
for (let i = 0; i < total; i++) {
  const byName = new Map() // the request cookie jar keeps the last value for a repeated name
  for (let j = 0, n = 1 + Math.floor(Math.random() * 4); j < n; j++) byName.set(pick(names), pick(pieces))
  const unique = [...byName].map(([name, value]) => ({ name, value }))
  let threw = false
  try { await client(unique).auth.getUser() } catch { threw = true }
  const flagged = brokenSessionCookieNames(unique).length > 0
  if (flagged !== threw) mismatches.push({ flagged, threw, jar: JSON.stringify(unique).slice(0, 300) })
  if (threw) broken++
  try { await client(withoutBrokenSessionCookies(unique)).auth.getUser() } catch (e) { mismatches.push({ afterCleaning: String(e.message), jar: JSON.stringify(unique).slice(0, 300) }) }
}
await new Promise((r) => setTimeout(r, 100))
console.log(JSON.stringify({ total, broken, mismatches }))
