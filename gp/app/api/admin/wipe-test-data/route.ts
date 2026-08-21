import { createAdminClient } from '@/lib/supabase/server'
import { deleteSubUser } from '@/lib/geonode'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// One-time pre-launch cleanup — hard-deletes every non-admin account, for
// clearing out QA/test data before going live. Deliberately NOT the same
// path as /api/admin/delete-user, which soft-deletes (anonymises +
// permanently bans, keeps the row) by design — that route exists for real
// customer deletions where financial/audit records need to survive.
//
// IMPORTANT — this route does NOT rely on any ON DELETE CASCADE, despite
// the schema describing several (profiles -> auth.users, and everything
// else -> profiles). Investigating why auth.admin.deleteUser() was
// returning "User not found" for accounts still fully visible in
// /admin/users turned up real schema drift in production: some accounts'
// auth.users rows were already gone (most likely from earlier manual
// cleanup during testing, via the Supabase dashboard or otherwise) while
// their profiles rows — which are only supposed to be able to exist
// because of that same FK — were still very much present. Something about
// how those rows came to exist or got partially cleaned up left the
// cascade unreliable in practice, however it happened. Given that, this
// route treats every cascade in the schema as advisory, not guaranteed,
// and explicitly deletes every table by user_id itself rather than
// deleting one row and hoping the rest follows.
//
// Protected by: admin role, MFA-verified session, and an exact
// confirmation phrase — plus dry_run defaults to true so a bare call
// never deletes anything by accident; you have to explicitly pass
// dry_run: false to execute. Consider deleting this route (or at least
// commenting it out) once you're done using it — there's no reason for
// it to exist in a launched product.
const CONFIRM_PHRASE = 'DELETE ALL TEST ACCOUNTS'

export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: { user: caller } } = await supabase.auth.getUser(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await supabase.from('profiles').select('role').eq('id', caller.id).single()
  if (callerProfile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const mfaCheck = await requireMfaVerified(req, caller.id)
  if (mfaCheck) return mfaCheck

  const body = await req.json().catch(() => ({}))
  if (body?.confirm !== CONFIRM_PHRASE) {
    return NextResponse.json({ error: `Body must include { "confirm": "${CONFIRM_PHRASE}" }` }, { status: 400 })
  }
  const dryRun = body?.dry_run !== false // anything other than an explicit false stays a dry run

  // Protect by role, not by "whoever's calling this" — every row with
  // role='admin' survives, full stop, regardless of how many there
  // happen to be. Simpler and safer than trying to name a specific
  // account to keep.
  const { data: targets, error: targetsErr } = await supabase
    .from('profiles')
    .select('id, email, role')
    .neq('role', 'admin')

  if (targetsErr) return NextResponse.json({ error: targetsErr.message }, { status: 500 })

  const { data: survivors } = await supabase.from('profiles').select('email').eq('role', 'admin')

  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      would_delete_count: targets?.length ?? 0,
      would_delete_emails: (targets ?? []).map(t => t.email),
      would_survive: (survivors ?? []).map(s => s.email),
      note: 'Nothing was deleted. Re-call with { "confirm": "' + CONFIRM_PHRASE + '", "dry_run": false } to actually run this.',
    })
  }

  if (!targets || targets.length === 0) {
    return NextResponse.json({ success: true, deleted_count: 0, note: 'No non-admin accounts found.' })
  }

  const targetIds = targets.map(t => t.id)

  // Step 1: clean up live Geonode sub-users before touching any local
  // rows — skipping this would leave real, billable sub-users orphaned
  // on Geonode's side with nothing locally left to find or clean them up
  // once the DB rows are gone.
  const { data: allCreds } = await supabase
    .from('proxy_credentials')
    .select('id, geonode_sub_user_id')
    .in('user_id', targetIds)
    .not('geonode_sub_user_id', 'is', null)

  let geonodeCleanedUp = 0
  const geonodeFailures: string[] = []
  for (const cred of allCreds ?? []) {
    if (!cred.geonode_sub_user_id) continue
    try {
      await deleteSubUser(cred.geonode_sub_user_id)
      geonodeCleanedUp++
    } catch (e) {
      console.error('[wipe-test-data] Geonode cleanup failed for', cred.id, e)
      geonodeFailures.push(cred.id)
    }
  }

  // Step 2: reseller_transfers and banned_emails aren't scoped to a
  // single user_id column the way everything else is (reseller_id +
  // recipient_id, and a nullable banned_by) — pure test artifacts either
  // way, so cleared entirely rather than filtered.
  const { error: transfersErr } = await supabase.from('reseller_transfers').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  if (transfersErr) console.error('[wipe-test-data] Failed to clear reseller_transfers:', transfersErr)

  const { error: bannedErr } = await supabase.from('banned_emails').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  if (bannedErr) console.error('[wipe-test-data] Failed to clear banned_emails:', bannedErr)

  // Step 3: explicit, table-by-table deletion for everything else keyed
  // on user_id — not relying on any cascade from profiles, per the
  // investigation above. Order matters here only in that proxy_sessions
  // references proxy_credentials directly (not just user_id), so it goes
  // first purely for tidiness, though deleting proxy_credentials before
  // it would still succeed today since that FK IS cascade — this route
  // just isn't betting on that being true either way.
  const childTables = [
    'mfa_verified_sessions',
    'mfa_backup_codes',
    'mfa_totp_factors',
    'webhook_endpoints',
    'api_keys',
    'proxy_sessions',
    'proxy_credentials',
    'orders',
    'bandwidth_accounts',
  ] as const

  const tableErrors: Record<string, string> = {}
  for (const table of childTables) {
    const { error } = await supabase.from(table).delete().in('user_id', targetIds)
    if (error) {
      console.error(`[wipe-test-data] Failed to clear ${table}:`, error)
      tableErrors[table] = error.message
    }
  }

  // proxy_credentials.created_by can point at one of these accounts even
  // on a row OWNED by someone who isn't being deleted (e.g. a reseller in
  // the target list who allocated bandwidth to an account outside it) —
  // the explicit delete above only catches rows where user_id matches,
  // so any such row needs created_by nulled out directly rather than
  // deleted.
  const { error: createdByErr } = await supabase
    .from('proxy_credentials')
    .update({ created_by: null })
    .in('created_by', targetIds)
  if (createdByErr) console.error('[wipe-test-data] Failed to clear created_by references:', createdByErr)

  // Step 4: delete the profiles rows themselves, directly — this is the
  // row /admin/users actually reads, so this is what makes them
  // disappear from the app regardless of what auth.users looks like.
  const { error: profilesErr, count: profilesDeleted } = await supabase
    .from('profiles')
    .delete({ count: 'exact' })
    .in('id', targetIds)
  if (profilesErr) console.error('[wipe-test-data] Failed to clear profiles:', profilesErr)

  // Step 5: delete the auth.users row for each target, best-effort.
  // "User not found" here is expected and fine for any account whose
  // auth.users row was already gone before this ran (the orphaned-row
  // case this whole route was rewritten around) — not a real failure,
  // since the actual goal (no trace of this account left) is already
  // satisfied for those. Only a genuinely different error gets counted.
  let authDeletedCount = 0
  let alreadyGoneCount = 0
  const authFailures: { email: string; error: string }[] = []
  for (const t of targets) {
    const { error } = await supabase.auth.admin.deleteUser(t.id)
    if (!error) {
      authDeletedCount++
    } else if (/not found/i.test(error.message)) {
      alreadyGoneCount++
    } else {
      console.error('[wipe-test-data] Failed to delete auth user', t.email, error.message)
      authFailures.push({ email: t.email, error: error.message })
    }
  }

  return NextResponse.json({
    success: !profilesErr && authFailures.length === 0 && Object.keys(tableErrors).length === 0,
    profiles_deleted: profilesDeleted ?? 0,
    profiles_clear_error: profilesErr?.message ?? null,
    auth_users_deleted: authDeletedCount,
    auth_users_already_gone: alreadyGoneCount, // orphaned-row cases — expected, not a problem
    auth_delete_failures: authFailures,
    child_table_errors: tableErrors, // should be {} — any key here means that table didn't fully clear
    geonode_cleaned_up: geonodeCleanedUp,
    geonode_failures: geonodeFailures,
    transfers_clear_error: transfersErr?.message ?? null,
    banned_emails_clear_error: bannedErr?.message ?? null,
    created_by_clear_error: createdByErr?.message ?? null,
    survivors: (survivors ?? []).map(s => s.email),
  })
}
