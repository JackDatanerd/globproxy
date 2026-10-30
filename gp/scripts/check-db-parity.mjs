// check-db-parity.mjs — builds two real Postgres databases (pglite, in-process) and compares them.
//
//   A  =  supabase/schema.sql                                  (what a fresh project gets)
//   B  =  supabase/baseline/pre-0001-schema.sql + every file in supabase/migrations/, in order
//                                                              (what production actually ran)
//
// check-schema-sync.mjs only proves that object NAMES in the migrations also appear in schema.sql.
// It cannot see a dropped GRANT, a changed function body, a different constraint or default —
// which is exactly how a column grant from 0108 went missing from schema.sql. This compares the
// real catalogs: tables, columns (type / default / nullability / column privileges), constraints,
// indexes, triggers, RLS policies, function definitions (comments and whitespace ignored) and
// their EXECUTE privileges, default privileges, and the content of the small seed tables.
//
// It then asserts the security invariants the database layer relies on, on both databases:
//   - no public function is executable by anon / authenticated (the allow-list below is empty
//     unless a function is deliberately client-callable);
//   - a function created TOMORROW is not executable by anon / authenticated either (this is the
//     check that proves the default-privilege setting actually works);
//   - every public table has row level security on;
//   - every SECURITY DEFINER function pins its search_path;
//   - `authenticated` can UPDATE only the allow-listed profile columns, and cannot INSERT/DELETE.
//
// Needs the pglite package, which is deliberately NOT a project dependency (it is only a test
// database, and adding it to package.json would re-resolve the whole dependency tree). It is
// installed beside this script, in scripts/node_modules (gitignored), where Node finds it:
//     npm install --prefix scripts --no-save --no-package-lock --ignore-scripts @electric-sql/pglite@0.5.10
// Run:  npm run check:db      (add  --root <dir> / --baseline <file>  to point at another tree)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d }
const root = path.resolve(arg('--root', path.join(here, '..')))
const baselineFile = path.resolve(arg('--baseline', path.join(root, 'supabase/baseline/pre-0001-schema.sql')))
const migDir = path.join(root, 'supabase/migrations')
const schemaFile = path.join(root, 'supabase/schema.sql')

// Functions a client is deliberately allowed to call (name → why). Keep this empty if you can.
const CLIENT_CALLABLE_ALLOWLIST = {}
// The only profile columns the browser writes (app/dashboard/settings/page.tsx). Keep in step
// with the GRANT UPDATE (...) in migration 0112.
const PROFILE_UPDATABLE = ['company_name', 'full_name', 'low_bandwidth_emails', 'marketing_emails', 'usage_urgent_pct', 'usage_warn_pct']

let PGlite, uuid_ossp, pgcrypto
try {
  ;({ PGlite } = await import('@electric-sql/pglite'))
  ;({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'))
  ;({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'))
} catch {
  console.error('[check-db-parity] @electric-sql/pglite is not installed. Run:\n  npm install --prefix scripts --no-save --no-package-lock --ignore-scripts @electric-sql/pglite@0.5.10')
  process.exit(2)
}

// The few Supabase-owned objects the schema leans on. Deliberately minimal.
const STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text,
  raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb,
  encrypted_password text, email_confirmed_at timestamptz, banned_until timestamptz,
  email_change text, email_change_sent_at timestamptz, email_change_token_new text,
  email_change_token_current text, confirmation_token text, recovery_token text, phone text,
  is_anonymous boolean default false, last_sign_in_at timestamptz, deleted_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table auth.sessions (id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade, created_at timestamptz default now(),
  updated_at timestamptz default now(), not_after timestamptz, user_agent text, ip inet);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true),'')::text $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
grant usage on schema public, extensions to anon, authenticated, service_role;
-- what Supabase itself sets up for the postgres role in public:
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`
async function fresh() {
  const db = new PGlite({ extensions: { uuid_ossp, pgcrypto } })
  await db.exec('create extension if not exists "uuid-ossp"; create schema extensions; create extension if not exists pgcrypto with schema extensions;')
  await db.exec(STUB)
  return db
}
const read = (f) => fs.readFileSync(f, 'utf8')
for (const f of [schemaFile, baselineFile]) if (!fs.existsSync(f)) { console.error(`[check-db-parity] missing ${f}`); process.exit(2) }

const A = await fresh()
try { await A.exec(read(schemaFile)) } catch (e) { console.error(`[check-db-parity] schema.sql does not apply on a clean database: ${e.message}`); process.exit(1) }
const B = await fresh()
try { await B.exec(read(baselineFile)) } catch (e) { console.error(`[check-db-parity] baseline does not apply: ${e.message}`); process.exit(2) }
for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
  try { await B.exec(read(path.join(migDir, f))) } catch (e) { console.error(`[check-db-parity] migration ${f} fails on top of the previous ones: ${e.message}`); process.exit(1) }
}

const rows = async (db, sql) => (await db.query(sql)).rows
const squash = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim()
const mask = (s) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d(?::?\d\d)?)?/g, '<ts>')

async function catalog(db) {
  const out = {}
  const put = (k, list) => { out[k] = new Map(list.map((x) => [x[0], x[1]])) }
  put('table', (await rows(db, `select c.relname k, 'kind='||c.relkind::text||' rls='||c.relrowsecurity||' force='||c.relforcerowsecurity||' acl='||coalesce(c.relacl::text,'') v from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','S','p')`)).map((r) => [r.k, r.v]))
  put('column', (await rows(db, `select c.relname||'.'||a.attname k, format_type(a.atttypid,a.atttypmod)||' notnull='||a.attnotnull||' def='||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||' gen='||a.attgenerated::text||' acl='||coalesce(a.attacl::text,'') v from pg_attribute a join pg_class c on c.oid=a.attrelid left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v') and a.attnum>0 and not a.attisdropped`)).map((r) => [r.k, r.v]))
  put('constraint', (await rows(db, `select c.relname||' '||k.conname k, k.contype::text||' '||pg_get_constraintdef(k.oid) v from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace`)).map((r) => [r.k, r.v]))
  put('index', (await rows(db, `select indexname k, indexdef v from pg_indexes where schemaname='public'`)).map((r) => [r.k, r.v]))
  put('trigger', (await rows(db, `select c.relnamespace::regnamespace::text||'.'||c.relname||'.'||t.tgname k, pg_get_triggerdef(t.oid)||' enabled='||t.tgenabled::text v from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relnamespace in ('public'::regnamespace,'auth'::regnamespace)`)).map((r) => [r.k, r.v]))
  put('policy', (await rows(db, `select tablename||' | '||policyname k, cmd||' '||roles::text||' '||permissive||' using='||coalesce(qual,'')||' check='||coalesce(with_check,'') v from pg_policies where schemaname='public'`)).map((r) => [r.k, r.v]))
  put('function', (await rows(db, `select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' k, p.prosecdef::text||' '||coalesce(p.proconfig::text,'')||' '||coalesce(p.proacl::text,'<default>')||' '||case when p.prokind in ('f','p') then pg_get_functiondef(p.oid) else '' end v from pg_proc p where p.pronamespace='public'::regnamespace`)).map((r) => [r.k, squash(r.v)]))
  put('default_acl', (await rows(db, `select defaclrole::regrole::text||' '||coalesce(defaclnamespace::regnamespace::text,'*')||' '||defaclobjtype::text k, defaclacl::text v from pg_default_acl`)).map((r) => [r.k, r.v]))
  const data = []
  for (const t of (await rows(db, `select relname t from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1`)).map((r) => r.t)) {
    const n = (await rows(db, `select count(*)::int c from public."${t}"`))[0].c
    if (n === 0 || n >= 500) continue
    const rs = (await rows(db, `select x::text r from public."${t}" x`)).map((r) => mask(r.r)).sort()
    data.push([`data ${t}`, rs.join('\n')])
  }
  put('seed', data)
  return out
}
const [ca, cb] = [await catalog(A), await catalog(B)]

const problems = []
const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return `…${a.slice(Math.max(0, i - 40), i + 80)}\n        vs  …${b.slice(Math.max(0, i - 40), i + 80)}` }
for (const kind of Object.keys(ca)) {
  for (const k of new Set([...ca[kind].keys(), ...cb[kind].keys()])) {
    const a = ca[kind].get(k), b = cb[kind].get(k)
    if (a === undefined) problems.push(`[${kind}] only in the migrations, missing from schema.sql: ${k}`)
    else if (b === undefined) problems.push(`[${kind}] only in schema.sql, no migration produces it: ${k}`)
    else if (a !== b) {
      if (kind === 'seed') {
        const [la, lb] = [new Set(a.split('\n')), new Set(b.split('\n'))]
        const onlyA = [...la].filter((x) => !lb.has(x)), onlyB = [...lb].filter((x) => !la.has(x))
        const show = (l) => l.slice(0, 5).map((x) => x.slice(0, 120)).join(' | ') + (l.length > 5 ? ` … (+${l.length - 5} more)` : '')
        problems.push(`[seed] ${k} differs — ${onlyA.length} row(s) only in schema.sql${onlyA.length ? ': ' + show(onlyA) : ''}; ${onlyB.length} row(s) only in the migrations${onlyB.length ? ': ' + show(onlyB) : ''}`)
      } else problems.push(`[${kind}] differs: ${k}\n        schema.sql  ${kind === 'function' ? firstDiff(a, b) : `${a}\n        migrations  ${b}`}`)
    }
  }
}

// ── invariants, checked on both databases ───────────────────────────────────────────────────────
for (const [label, db] of [['schema.sql', A], ['migrations', B]]) {
  const bad = (m) => problems.push(`[invariant:${label}] ${m}`)
  for (const r of await rows(db, `select p.proname n, pg_get_function_identity_arguments(p.oid) a from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in ('f','p') and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute')) and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')`)) {
    if (!(r.n in CLIENT_CALLABLE_ALLOWLIST)) bad(`function ${r.n}(${r.a}) is executable by anon/authenticated (revoke all … from public, anon, authenticated)`)
  }
  await db.exec(`create function public.zz_guard_probe() returns int language sql security definer as $$ select 1 $$`)
  const probe = (await rows(db, `select has_function_privilege('anon',oid,'execute') a, has_function_privilege('authenticated',oid,'execute') u from pg_proc where proname='zz_guard_probe'`))[0]
  await db.exec('drop function public.zz_guard_probe()')
  if (probe.a || probe.u) bad('a function created later is executable by anon/authenticated — the default privileges do not protect new functions')
  for (const r of await rows(db, `select relname n from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p') and not relrowsecurity`)) bad(`table ${r.n} has row level security off`)
  for (const r of await rows(db, `select p.proname n from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')`)) bad(`SECURITY DEFINER function ${r.n} does not pin search_path`)
  const upd = (await rows(db, `select a.attname n from pg_attribute a where a.attrelid='public.profiles'::regclass and a.attnum>0 and not a.attisdropped and has_column_privilege('authenticated','public.profiles',a.attnum,'update') order by 1`)).map((r) => r.n)
  if (JSON.stringify(upd) !== JSON.stringify(PROFILE_UPDATABLE)) bad(`authenticated can update profiles columns [${upd.join(', ')}], expected exactly [${PROFILE_UPDATABLE.join(', ')}]`)
  for (const p of ['insert', 'delete', 'truncate']) {
    if ((await rows(db, `select has_table_privilege('authenticated','public.profiles','${p}') x`))[0].x) bad(`authenticated has ${p.toUpperCase()} on profiles`)
  }
  if (!(await rows(db, `select has_column_privilege('authenticated','public.profiles','marketing_emails','select') x`))[0].x) bad('authenticated cannot read profiles.marketing_emails (the settings toggle needs it)')
}

// ── write privileges must be backed by RLS policies (0114) ───────────────────────────────────────
// A client role holding INSERT / UPDATE / DELETE with no policy for that command is protected only by
// "RLS has no policy" — one careless policy away from a hole. TRUNCATE ignores RLS entirely.
for (const [label, db] of [['schema.sql', A], ['migrations', B]]) {
  const bad = (m) => problems.push(`[invariant:${label}] ${m}`)
  for (const role of ['anon', 'authenticated']) {
    for (const r of await rows(db, `select c.relname n, p.priv, (select count(*) from pg_policy x where x.polrelid=c.oid and x.polcmd = any (case p.priv when 'insert' then array['a','*'] when 'update' then array['w','*'] else array['d','*'] end::"char"[]) and (0 = any (x.polroles) or '${role}'::regrole::oid = any (x.polroles)))::int pol from pg_class c cross join (values ('insert'),('update'),('delete')) p(priv) where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and has_table_privilege('${role}', c.oid, p.priv)`)) {
      if (r.pol === 0) bad(`${role} has ${r.priv.toUpperCase()} on ${r.n} but no RLS policy covers it (revoke it)`)
    }
    for (const r of await rows(db, `select c.relname n, p.priv from pg_class c cross join (values ('truncate'),('references'),('trigger')) p(priv) where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and has_table_privilege('${role}', c.oid, p.priv)`)) {
      bad(`${role} has ${r.priv.toUpperCase()} on ${r.n}`)
    }
    for (const r of await rows(db, `select c.relname n from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='S' and (has_sequence_privilege('${role}', c.oid, 'usage') or has_sequence_privilege('${role}', c.oid, 'update'))`)) {
      bad(`${role} has privileges on sequence ${r.n}`)
    }
  }
  // protect_order_columns must restore every orders column except payment_status (the one a customer may set, to 'cancelled').
  const prot = (await rows(db, `select pg_get_functiondef(oid) d from pg_proc where proname='protect_order_columns' and pronamespace='public'::regnamespace`))[0]?.d ?? ''
  for (const r of await rows(db, `select attname n from pg_attribute where attrelid='public.orders'::regclass and attnum>0 and not attisdropped and attname <> 'payment_status'`)) {
    if (!new RegExp(`new\\.${r.n}\\s*:=\\s*old\\.${r.n}\\b`).test(prot)) bad(`protect_order_columns does not restore orders.${r.n} — a customer cancelling their own order could rewrite it`)
  }
}

// ── behaviour as a real customer (the browser's role), on both databases ─────────────────────────
for (const [label, db] of [['schema.sql', A], ['migrations', B]]) {
  const bad = (m) => problems.push(`[behaviour:${label}] ${m}`)
  const U = '0d0d0d0d-0000-4000-8000-000000000001', V = '0d0d0d0d-0000-4000-8000-000000000002'
  await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${U}','parity-a@example.test', now()), ('${V}','parity-b@example.test', now())`)
  const cred = (await rows(db, `insert into public.proxy_credentials (user_id, label, status, session_type, gb_allocated) values ('${U}','s','active','sticky',1) returning id`))[0].id
  const rot = (await rows(db, `insert into public.proxy_credentials (user_id, label, status, session_type, gb_allocated) values ('${U}','r','active','rotating',1) returning id`))[0].id
  const order = (await rows(db, `insert into public.orders (user_id, gb_amount, amount_usd, payment_status) values ('${U}',10,35,'pending') returning id`))[0].id
  const asUser = async (uid, sql) => {
    await db.exec(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated`)
    try { const r = await db.query(sql); return { ok: true, rows: r.rows, n: r.affectedRows ?? r.rows.length } }
    catch (e) { return { ok: false, err: e.message } }
    finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false)`) }
  }
  const mustFail = async (what, uid, sql) => { const r = await asUser(uid, sql); if (r.ok) bad(`${what} was allowed`) }
  const mustHold = async (what, uid, sql, col, want) => { const r = await asUser(uid, sql); if (!r.ok) return bad(`${what} errored: ${r.err}`); if (String(r.rows[0]?.[col]) !== String(want)) bad(`${what} changed ${col} to ${r.rows[0]?.[col]} (expected it to stay ${want})`) }

  await mustFail('a 5 MB session label', U, `insert into public.proxy_sessions (credential_id,user_id,session_token,label) values ('${cred}','${U}','abcdef',repeat('x',5000000))`)
  await mustFail('a 1 MB company_name', U, `update public.profiles set company_name = repeat('y',1000000) where id='${U}'`)
  await mustFail('a 1 MB full_name', U, `update public.profiles set full_name = repeat('y',1000000) where id='${U}'`)
  await db.exec(`insert into public.proxy_sessions (credential_id,user_id,session_token,label) values ('${cred}','${U}','abcdef','keep'), ('${cred}','${U}','abcdeg','gone')`)
  await db.exec(`update public.proxy_sessions set terminated_at = now() where session_token = 'abcdeg'`)
  await mustHold('re-parenting a session onto another credential', U, `update public.proxy_sessions set credential_id='${rot}' where session_token='abcdef' returning credential_id`, 'credential_id', cred)
  await mustHold('rewriting a session token', U, `update public.proxy_sessions set session_token='zzzzzz' where session_token='abcdef' returning session_token`, 'session_token', 'abcdef')
  const rev = await asUser(U, `update public.proxy_sessions set terminated_at = null where session_token='abcdeg' returning terminated_at`)
  if (!rev.ok || rev.rows[0]?.terminated_at == null) bad('un-terminating a terminated session was allowed')
  await mustHold('renaming an own session', U, `update public.proxy_sessions set label='renamed' where session_token='abcdef' returning label`, 'label', 'renamed')
  await mustHold('rewriting orders.id when cancelling an own order', U, `update public.orders set id='0d0d0d0d-0000-4000-8000-0000000000ff', payment_status='cancelled' where id='${order}' returning id`, 'id', order)
  await db.exec(`update public.profiles set is_suspended = true where id='${U}'`)
  await mustFail('a suspended account editing its session', U, `update public.proxy_sessions set label='x' where session_token='abcdef' returning 1`)
  const del = await asUser(U, `delete from public.proxy_sessions where session_token='abcdef' returning 1`)
  if (del.ok && del.rows.length) bad('a suspended account deleting its session was allowed')
  await db.exec(`update public.profiles set is_suspended = false where id='${U}'`)
  const own = await asUser(U, `delete from public.proxy_sessions where session_token='abcdef' returning 1`)
  if (!own.ok || own.rows.length !== 1) bad('an active customer can no longer delete their own session')
  const other = await asUser(V, `select count(*)::int c from public.proxy_sessions`)
  if (!other.ok || other.rows[0].c !== 0) bad("another customer can see someone else's sessions")
}

if (problems.length) {
  console.error(`[check-db-parity] FAILED — ${problems.length} problem(s):\n`)
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
const mig = fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).length
console.log(`[check-db-parity] OK — schema.sql and baseline+${mig} migrations produce identical catalogs; grant / RLS / search_path invariants hold on both`)
