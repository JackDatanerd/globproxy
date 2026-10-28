import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// The behaviour of these paths was exercised against an in-memory database when they were written;
// these assertions pin the wiring so a refactor cannot quietly undo it.

test('Report an issue files the report in the shared inbox and only falls back to ADMIN_EMAIL if that fails', () => {
  const s = read('app/api/support/report/route.ts')
  assert.match(s, /ingestReport\(/)
  assert.match(s, /notifyOperator\(/)
  assert.match(s, /const adminTo = inInbox \? undefined : process\.env\.ADMIN_EMAIL/, 'direct e-mail only as a fallback (report)')
  assert.match(s, /const adminTo = inInboxF \? undefined : process\.env\.ADMIN_EMAIL/, 'direct e-mail only as a fallback (follow-up)')
  // the report row is still saved first
  assert.ok(s.indexOf("from('support_reports').insert") < s.indexOf('fileInInbox(supabase, {\n      reportId: report.id'))
})

test('a customer reply into an existing conversation alerts the operator unless it was already unread', () => {
  const s = read('app/api/internal/inbound-email/route.ts')
  assert.match(s, /result\.newThread \|\| !result\.wasUnread/)
  assert.match(s, /!result\.auto/, 'automatic mail never alerts')
  const ing = read('lib/inboxIngest.ts')
  assert.match(ing, /wasUnread = !!t\.unread/)
})

test('operator alerts never go to an inbox address and never throw', () => {
  const s = read('lib/inboxNotify.ts')
  assert.match(s, /INBOX_ADDRESSES as readonly string\[\]\)\.includes\(to\.toLowerCase\(\)\)/)
  assert.match(s, /sendEmailSafe/)
  assert.match(s, /process\.env\.ADMIN_EMAIL/)
})

test('report messages are keyed by the report so filing is idempotent and follow-ups find their thread', () => {
  const s = read('lib/inboxIngest.ts')
  assert.match(s, /`report-\$\{p\.reportId\}@globproxy\.com`/)
  assert.match(s, /report-\$\{p\.reportId\}-\$\{p\.followUpId\}@globproxy\.com/)
  assert.match(s, /customer_user_id: p\.userId/)
})
