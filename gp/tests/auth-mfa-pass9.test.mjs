// Regression guards for Auth & MFA pass 9.
// - validateEmail is executed for real (bundled with esbuild so the @/ alias resolves).
// - Everything that needs the Workers runtime or a database is pinned in source / SQL; the SQL itself
//   was exercised against a real PostgreSQL when it was written (see migration 0101).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

async function load(entry) {
  const out = await build({
    entryPoints: [path.join(root, entry)], bundle: true, format: 'esm', platform: 'node',
    write: false, tsconfig: path.join(root, 'tsconfig.json'),
  })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}

// ── B7 ───────────────────────────────────────────────────────────────────
test('validateEmail refuses trailing-dot and invisible-character domains instead of letting them dodge the disposable list', async () => {
  const { validateEmail, isDisposableDomain } = await load('lib/email-validation.ts')
  assert.equal(validateEmail('a@mailinator.com').valid, false)            // the list still works
  assert.equal(validateEmail('a@mailinator.com.').valid, false)           // trailing dot
  assert.equal(validateEmail('a@x.mailinator.com.').valid, false)
  assert.equal(validateEmail('a@mailinator.com\u200b').valid, false)      // zero-width space
  assert.equal(validateEmail('a@mailinator.com\u00ad').valid, false)      // soft hyphen
  assert.equal(validateEmail('a@a..com').valid, false)
  assert.equal(validateEmail('a@.com').valid, false)
  assert.equal(isDisposableDomain('MAILINATOR.com.'), true)               // defence in depth
  // ordinary addresses are untouched, including plus-addressing and an IDN domain
  for (const ok of ['a@gmail.com', 'first.last+tag@sub.example.co.uk', 'a@münchen.de']) {
    assert.equal(validateEmail(ok).valid, true, ok)
  }
})

test('0101 rejects the same malformed domains in both e-mail policy triggers', () => {
  const m = read('supabase/migrations/0101_auth_mfa_pass9.sql')
  for (const fn of ['enforce_signup_policy', 'enforce_email_change_policy']) {
    const at = m.indexOf(`function public.${fn}()`)
    assert.ok(at > 0, fn)
    const body = m.slice(at, at + 1400)
    assert.match(body, /\\u200b-\\u200f/)
    assert.match(body, /\(\^\\\.\|\\\.\$\|\\\.\\\.\)/)
    assert.ok(body.indexOf('valid email address') < body.indexOf('is_email_banned'), `${fn}: format check runs before the ban check`)
  }
  assert.doesNotMatch(m, /create or replace function public\.normalize_ban_email/, 'normalize_ban_email backs an expression index — leave it alone')
})

// ── B2 ───────────────────────────────────────────────────────────────────
test('security events are served by a 2FA-gated route and no longer queried from the browser', () => {
  const route = read('app/api/auth/security-events/route.ts')
  assert.match(route, /requireActiveUser/)
  assert.match(route, /requireMfaVerified\(req, user\.id\)/)
  assert.match(route, /\.eq\('user_id', user\.id\)/)
  const sel = route.slice(route.indexOf('.select('), route.indexOf('.select(') + 120)
  assert.match(sel, /id, event, ip, user_agent, created_at, country:meta->>country/)
  assert.doesNotMatch(sel, /actor_id|\*/, 'actor_id / raw meta must not be returned')
  const card = read('components/dashboard/AccountSecurityCards.tsx')
  assert.doesNotMatch(card, /from\('security_events'\)/)
  assert.match(card, /fetch\('\/api\/auth\/security-events'/)
  assert.match(read('supabase/migrations/0101_auth_mfa_pass9.sql'), /drop policy if exists "Own security events" on public\.security_events/)
})

test('no other browser-side or session-client code reads security_events', () => {
  const walk = (d) => readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' || e.name === '.next' ? [] : walk(`${d}/${e.name}`)) : [`${d}/${e.name}`])
  for (const f of [...walk('app'), ...walk('components')].filter((x) => /\.tsx?$/.test(x))) {
    const s = read(f)
    if (!s.includes("from('security_events')")) continue
    assert.match(s, /createAdminClient|authorizeAdmin/, `${f} reads security_events, so it must use the service role`)
  }
})

// ── B6 ───────────────────────────────────────────────────────────────────
test('"Sign out other devices" sends a 2FA-unverified session to the code prompt', () => {
  const s = read('components/dashboard/AccountSecurityCards.tsx')
  const at = s.indexOf('async function signOutOthers')
  assert.match(s.slice(at, at + 1200), /mfa_required[\s\S]*router\.push\(`\/auth\/mfa-verify\?next=/)
})

// ── B1 ───────────────────────────────────────────────────────────────────
const SENSITIVE = ['payout_wallet_address', 'payout_mpesa_phone', 'payout_bank_details']

test('payout destination columns are not selectable by signed-in users', () => {
  const m = read('supabase/migrations/0101_auth_mfa_pass9.sql')
  assert.match(m, /revoke select on public\.profiles from anon, authenticated/)
  for (const c of SENSITIVE) assert.match(m, new RegExp(`'${c}'`))
  assert.match(m, /grant select \(%s\) on public\.profiles to authenticated/)
})

test('the referrals page reads the payout columns with the service role, scoped to the verified user', () => {
  const s = read('app/dashboard/referrals/page.tsx')
  const at = s.indexOf("from('profiles')")
  assert.ok(at > 0)
  assert.match(s.slice(at - 40, at), /admin\s*\.?$|admin\.?\s*$/)
  assert.match(s.slice(at, at + 700), /\.eq\('id', user\.id\)/)
  assert.match(s, /maskWallet\(profile\?\.payout_wallet_address\)/)
})

test('no user-session code selects the payout columns, or `*` from profiles', () => {
  const walk = (d) => readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' || e.name === '.next' ? [] : walk(`${d}/${e.name}`)) : [`${d}/${e.name}`])
  for (const f of [...walk('components'), 'app/dashboard/settings/page.tsx', 'middleware.ts']) {
    const s = read(f)
    for (const m of s.matchAll(/from\('profiles'\)[\s\S]{0,200}/g)) {
      assert.doesNotMatch(m[0].split(';')[0], /payout_(wallet_address|mpesa_phone|bank_details)|select\(\s*['"`]\*/, `${f}`)
    }
  }
})

test('every migration after 0101 that adds a profiles column also grants SELECT on it', () => {
  const dir = path.join(root, 'supabase/migrations')
  const later = readdirSync(dir).filter((f) => /^\d{4}_/.test(f) && Number(f.slice(0, 4)) > 101).sort()
  for (const f of later) {
    const sql = readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '')
    for (const stmt of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?profiles\b([^;]*);/gi)) {
      for (const col of stmt[1].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi)) {
        const name = col[1]
        if (SENSITIVE.includes(name)) continue
        const granted = new RegExp(`grant\\s+select\\s*\\([^)]*\\b${name}\\b[^)]*\\)\\s+on\\s+(?:table\\s+)?(?:public\\.)?profiles`, 'i').test(sql)
        assert.ok(granted, `${f} adds profiles.${name} but never runs: grant select (${name}) on public.profiles to authenticated;\n` +
          `(profiles is column-granted since 0101, so signed-in users could not read it)`)
      }
    }
  }
})

// ── B3 ───────────────────────────────────────────────────────────────────
test('resend-confirmation drops a squatter\'s referral when the password is replaced, like signup does', () => {
  const s = read('app/api/auth/resend-confirmation/route.ts')
  const swap = s.indexOf("rpc('auth_replace_unconfirmed_password'")
  const reset = s.indexOf("rpc('reset_unconfirmed_referral'")
  assert.ok(swap > 0 && reset > swap, 'reset happens after the password swap')
  assert.match(s.slice(swap, swap + 400), /if \(!replaced\) return/)
  assert.match(s.slice(reset, reset + 900), /readCookie\(cookieHeader, REF_COOKIE\)/)
  // and it is the visitor's OWN cookie, never a code taken from the request body
  assert.doesNotMatch(s.slice(reset, reset + 900), /referral_code/)
})

// ── B4 / B5 ──────────────────────────────────────────────────────────────
test('reset and signup pages recover from a thrown fetch instead of sticking on "loading"', () => {
  for (const p of ['app/auth/reset/page.tsx', 'app/auth/signup/page.tsx']) {
    const s = read(p)
    const at = s.indexOf('res = await fetch(')
    assert.ok(at > 0, p)
    const after = s.slice(at, at + 900)
    assert.match(after, /\} catch \{[\s\S]*Network error[\s\S]*setLoading\(false\)[\s\S]*setCaptchaReset/, p)
  }
})

test('mfa-recovery turns a network failure into a result instead of throwing', () => {
  const s = read('app/auth/mfa-recovery/page.tsx')
  const at = s.indexOf('async function call')
  assert.match(s.slice(at, at + 900), /try \{[\s\S]*\} catch \{[\s\S]*status: 0/)
  assert.match(s, /if \(r\.status === 0\) \{ setLoadFailed\(true\); return \}/)
})

test('login re-arms the captcha after a thrown fetch', () => {
  const s = read('app/auth/login/page.tsx')
  const at = s.lastIndexOf("toast.error('Network error. Please try again.')")
  assert.match(s.slice(at, at + 300), /setCaptcha\(null\)[\s\S]*setCaptchaReset/)
})
