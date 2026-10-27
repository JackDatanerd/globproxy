// Edge pipeline: undecodable Supabase session cookies, Secure session cookies, and the
// whole-segment admin / reseller gates. The middleware cases run the REAL middleware.ts
// (bundled with esbuild) against a stubbed Supabase, so they exercise the real
// @supabase/ssr + auth-js client rather than a model of it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { brokenSessionCookieNames, withoutBrokenSessionCookies, sessionCookieOptions } from '../lib/sessionCookies.ts'
import { isProtectedPath, isUnderPrefix } from '../lib/protectedPaths.ts'

const REF = 'abcdref'
const K = `sb-${REF}-auth-token`
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url')
const NOW = Math.floor(Date.now() / 1000)
const sessionJson = (extra = {}) => JSON.stringify({ access_token: 'GOOD.x.y', refresh_token: 'r', expires_at: NOW + 3000, token_type: 'bearer', user: { id: 'u1' }, ...extra })
const good = 'base64-' + b64url(sessionJson())
const jar = (...pairs) => pairs.map(([name, value]) => ({ name, value }))

// ── the helper ────────────────────────────────────────────────────────────
test('only an undecodable base64- session value is reported, with every cookie of that session', () => {
  assert.deepEqual(brokenSessionCookieNames([]), [])
  assert.deepEqual(brokenSessionCookieNames(jar([K, good])), [])
  assert.deepEqual(brokenSessionCookieNames(jar([K, 'base64-!!!'])), [K])
  // Chunked: the joined value is what is decoded, and every chunk of that session goes.
  const bytes = Buffer.from(sessionJson())
  const bad = 'base64-' + Buffer.concat([bytes, Buffer.from([0xff, 0xfe])]).toString('base64url')
  const mid = Math.floor(bad.length / 2)
  assert.deepEqual(brokenSessionCookieNames(jar([`${K}.1`, bad.slice(mid)], [`${K}.0`, bad.slice(0, mid)])).sort(), [`${K}.0`, `${K}.1`])
  // Things the library already handles (signed out, cookie cleared) are left alone.
  assert.deepEqual(brokenSessionCookieNames(jar([K, 'zzz'])), [])
  assert.deepEqual(brokenSessionCookieNames(jar([K, 'base64-' + b64url('"str"')])), [])
  assert.deepEqual(brokenSessionCookieNames(jar([K, ''])), [])
  // An exact, valid cookie wins over a junk chunk next to it, exactly as in the library.
  assert.deepEqual(brokenSessionCookieNames(jar([K, good], [`${K}.0`, 'base64-!!!'])), [])
  // The PKCE verifier and unrelated cookies are not session cookies.
  assert.deepEqual(brokenSessionCookieNames(jar([`${K}-code-verifier`, 'base64-!!!'], ['theme', 'base64-!!!'])), [])
  // Another project's broken cookie does not touch this one's.
  assert.deepEqual(brokenSessionCookieNames(jar([K, good], ['sb-other-auth-token', 'base64-!!!'])), ['sb-other-auth-token'])
})

test('withoutBrokenSessionCookies keeps everything else and the same array when nothing is broken', () => {
  const clean = jar([K, good], ['gp_ref', 'x'])
  assert.equal(withoutBrokenSessionCookies(clean), clean)
  assert.deepEqual(withoutBrokenSessionCookies(jar([K, 'base64-!!!'], ['gp_ref', 'x'])), jar(['gp_ref', 'x']))
})

// Differential: the helper must agree with the real client about which cookies make
// getUser() throw — a false "broken" would sign people out, a missed one is this bug. It runs
// in a child process because the library leaves a rejected initial-session promise behind for
// exactly the cookies this is about, which node:test would report against the wrong test.
test('agrees with the real Supabase client on randomly built cookie jars', () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(new URL('./session-cookies-diff.mjs', import.meta.url))], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.deepEqual(out.mismatches, [])
  assert.ok(out.broken > 20, 'the random jars must actually exercise the broken case')
  assert.ok(out.total >= 400)
})

test('session cookies are written Secure unless a caller says otherwise', () => {
  assert.deepEqual(sessionCookieOptions({ path: '/', maxAge: 5 }, true), { path: '/', maxAge: 5, secure: true })
  assert.deepEqual(sessionCookieOptions(undefined, true), { secure: true })
  assert.deepEqual(sessionCookieOptions({ path: '/' }, false), { path: '/', secure: false }, 'local http dev keeps working')
  assert.equal(sessionCookieOptions({ secure: false }, true).secure, false, 'an explicit value is kept')
})

// ── whole-segment gates ───────────────────────────────────────────────────
test('admin / reseller prefixes are whole path segments, same as isProtectedPath', () => {
  assert.equal(isUnderPrefix('/admin', '/admin'), true)
  assert.equal(isUnderPrefix('/admin/users', '/admin'), true)
  assert.equal(isUnderPrefix('/administrator', '/admin'), false)
  assert.equal(isUnderPrefix('/reseller-program', '/reseller'), false)
  assert.equal(isProtectedPath('/administrator'), false)
  assert.equal(isProtectedPath('/invoice/123'), true)
})

// ── the real middleware ───────────────────────────────────────────────────
const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = fileURLToPath(new URL('../node_modules/.cache/mw-test/', import.meta.url))
mkdirSync(outDir, { recursive: true })
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../middleware.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  alias: { '@': root.replace(/\/$/, '') },
  external: ['next/server.js', '@supabase/*'],
  plugins: [{ name: 'next-server', setup(b) { b.onResolve({ filter: /^next\/server$/ }, () => ({ path: 'next/server.js', external: true })) } }],
})
const bundlePath = outDir + 'mw.mjs'
writeFileSync(bundlePath, bundled.outputFiles[0].text)
process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${REF}.supabase.co`
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
const { NextRequest } = await import('next/server.js')
const { middleware } = await import(pathToFileURL(bundlePath).href)
test.after(() => rmSync(outDir, { recursive: true, force: true }))

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } })
let profile
const realFetch = globalThis.fetch
globalThis.fetch = async (u, init) => {
  const p = new URL(String(u)).pathname
  if (p === '/auth/v1/user') return String(init?.headers?.Authorization ?? init?.headers?.authorization ?? '').includes('GOOD') ? json({ id: 'u1', email: 'a@b.c', aud: 'authenticated' }) : json({ msg: 'bad jwt' }, 401)
  if (p === '/rest/v1/profiles') return json({ role: 'user', is_suspended: false, is_deleted: false, mfa_enabled: false, ...profile })
  if (p === '/rest/v1/mfa_verified_sessions') return json([])
  if (p === '/auth/v1/logout') return new Response(null, { status: 204 })
  return json({}, 404)
}
test.after(() => { globalThis.fetch = realFetch })

async function call(path, cookie, prof = {}) {
  profile = prof
  const res = await middleware(new NextRequest('https://globproxy.com' + path, { headers: cookie ? { cookie } : {} }))
  const setCookies = res.headers.getSetCookie?.() ?? []
  return { res, status: res.status, location: res.headers.get('location'), setCookies }
}
const expired = (setCookies, name) => setCookies.some((c) => c.startsWith(name + '=;') && /Max-Age=0/i.test(c))

test('middleware: an undecodable session cookie is "no session" and is expired, not a permanent 503', async () => {
  const badCookie = `${K}=base64-!!!`
  const protectedPage = await call('/dashboard', badCookie)
  assert.equal(protectedPage.status, 307)
  assert.match(protectedPage.location, /\/auth\/login\?next=%2Fdashboard$/)
  assert.ok(expired(protectedPage.setCookies, K), 'the bad cookie is expired in the browser')

  const publicPage = await call('/', badCookie)
  assert.equal(publicPage.status, 200)
  assert.ok(expired(publicPage.setCookies, K))
  assert.ok(!(publicPage.res.headers.get('x-middleware-request-cookie') ?? '').includes(K), 'and the server components behind it no longer see it')

  const chunked = await call('/dashboard', `${K}.0=base64-${b64url('x').slice(0, 2)}!; ${K}.1=base64-zz`)
  assert.equal(chunked.status, 307)
  assert.ok(expired(chunked.setCookies, `${K}.0`) && expired(chunked.setCookies, `${K}.1`))
})

test('middleware: a good session is untouched and the gates still work', async () => {
  const ok = await call('/dashboard', `${K}=${good}`)
  assert.equal(ok.status, 200)
  assert.ok(!ok.setCookies.length)
  assert.equal((await call('/admin', `${K}=${good}`)).location, 'https://globproxy.com/dashboard')
  assert.equal((await call('/reseller/x', `${K}=${good}`)).location, 'https://globproxy.com/dashboard')
  assert.equal((await call('/administrator', `${K}=${good}`)).status, 200, '/administrator is not the admin area')
  assert.equal((await call('/reseller-program', `${K}=${good}`)).status, 200)
  assert.equal((await call('/admin', `${K}=${good}`, { role: 'admin', mfa_enabled: true })).location.includes('/auth/mfa-verify'), true)
})
