// The refresh brake (custom-worker.ts) only works if lib/sessionProbe.ts reads a session cookie
// EXACTLY as the server does. This runs the probe and the real @supabase/ssr + auth-js client on the
// same cookie headers and fails if the server calls Supabase Auth to refresh a session the probe
// did not report as 'refresh'. (Over-braking, the other direction, is allowed: it only costs the
// sender of an odd cookie.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server.js'
import { createServerClient } from '@supabase/ssr'
import { classifySession } from '../lib/sessionProbe.ts'
import { withoutBrokenSessionCookies } from '../lib/sessionCookies.ts'

process.on('unhandledRejection', () => {}) // the library leaves a rejected initial-session promise behind

const REF = 'abcdref'
const K = `sb-${REF}-auth-token`
const NOW_S = Math.floor(Date.now() / 1000)
const sessionJson = (o = {}) => JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', expires_at: NOW_S - 3600, token_type: 'bearer', user: { id: 'u' }, ...o })
const b64u = (buf) => Buffer.from(buf).toString('base64url')
const good = 'base64-' + b64u(sessionJson())

async function serverRefreshes(header) {
  let calls = 0
  const fetchStub = async (u) => {
    if (String(u).includes('grant_type=refresh_token')) calls++
    return new Response(JSON.stringify({ message: 'x' }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  const jar = withoutBrokenSessionCookies(new NextRequest('https://x.test/', { headers: { cookie: header } }).cookies.getAll())
  const sb = createServerClient(`https://${REF}.supabase.co`, 'anon', { cookies: { getAll: () => jar, setAll() {} }, global: { fetch: fetchStub } })
  try { await sb.auth.getUser() } catch { /* the stub answers 400 */ }
  return calls > 0
}

async function assertNotHidden(header, label) {
  const refreshes = await serverRefreshes(header)
  const probe = classifySession(header, Date.now(), K)
  if (refreshes) assert.equal(probe, 'refresh', `server refreshes but the probe says ${probe}: ${label ?? header.slice(0, 120)}`)
}

test('a refresh the server will make is never hidden from the probe: crafted base64 variants', async () => {
  const at = (n) => good.slice(0, n) + '{X}' + good.slice(n)
  const variants = {
    plain: good,
    trailingEq: good + '=',
    trailingEqEq: good + '==',
    extraChar: good + 'A',
    interiorEq: at(20).replace('{X}', '='),
    interiorSpace: at(20).replace('{X}', ' '),
    interiorEncodedSpace: at(20).replace('{X}', '%20'),
    interiorEncodedNewline: at(20).replace('{X}', '%0A'),
    interiorTab: at(20).replace('{X}', '\t'),
    manyIgnorable: at(15).replace('{X}', '= \n=\t'),
    // overlong UTF-8: C0 A2 is a double quote to the library, U+FFFD to a TextDecoder
    overlongQuote: 'base64-' + b64u(Buffer.concat([Buffer.from('{'), Buffer.from([0xc0, 0xa2]), Buffer.from('access_token'), Buffer.from([0xc0, 0xa2]), Buffer.from(`:"x",${sessionJson().slice(1)}`)])),
  }
  // Values are percent-encoded like a browser would send them (a raw newline cannot be in a header);
  // the cookie parser decodes them back, so the server sees the raw characters.
  for (const [name, value] of Object.entries(variants)) await assertNotHidden(`${K}=${encodeURIComponent(value)}`, name)
  // and the same value split across chunks
  const half = Math.floor(good.length / 2)
  await assertNotHidden(`${K}.0=${encodeURIComponent(good.slice(0, half))}; ${K}.1=${encodeURIComponent('=' + good.slice(half))}`, 'chunks with padding')
})

test('probe and real client agree on random cookie values (seeded)', async () => {
  let seed = 0x5eed1234
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const noise = ['=', ' ', '\t', '\n', '\r', '%20', '%0A', '%3D', 'A', '-', '_', '+', '/', '!', '\u00e9', '%']
  let refreshed = 0
  for (let i = 0; i < 400; i++) {
    let v = good
    for (let k = 0, n = Math.floor(rnd() * 4); k < n; k++) {
      const pos = Math.floor(rnd() * (v.length + 1))
      v = v.slice(0, pos) + pick(noise) + v.slice(pos)
    }
    if (rnd() < 0.15) v = v.slice(0, 7) + b64u(Buffer.from(Array.from({ length: 30 }, () => Math.floor(rnd() * 256))))
    const header = `${K}=${encodeURIComponent(v)}`
    if (await serverRefreshes(header)) refreshed++
    await assertNotHidden(header, JSON.stringify(v).slice(0, 140))
  }
  assert.ok(refreshed > 20, 'the generator must produce values the server really refreshes (' + refreshed + ')')
})
