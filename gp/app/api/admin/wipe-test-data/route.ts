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
// because of that same FK — were still very much present.
//
// That same orphaning turned out to run deeper than just profiles vs.
// auth.users: revenue/order/GB-sold totals on /admin stayed nonzero
// after profiles were fully cleared, because those numbers sum every
// paid order unconditionally — and some orders' owning profile had
// already been gone before this route ever ran, so they were never in
// its enumerated target list to begin with. Every table below is now
// swept by "does not belong to a surviving admin" rather than "belongs to
// one of the profiles we found just now" — the former has no blind spot
// for rows whose owner is already gone; the latter can only ever act on
// what it can currently see. Step 6 closes the mirror-image case too: an
// auth.users row with no profiles row at all, which no profiles-sourced
// query could ever enumerate no matter how it's written.
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

  const { data: survivors } = await supabase.from('profiles').select('id, email').eq('role', 'admin')
  const adminIds = (survivors ?? []).map((s: any) => s.id)

  // Shared by both branches — this is the auth-side mirror of the
  // profiles-side orphan case that started this whole investigation: an
  // auth.users row with no profiles row behind it at all, invisible to
  // `targets` no matter how that's queried since it's sourced from
  // profiles. Computed up front so the dry run can actually preview it
  // instead of only surfacing it after execution.
  async function findStrayAuthUsers() {
    let page = 1
    const stray: { id: string; email: string }[] = []
    while (true) {
      const { data: pageData, error: listErr } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
      if (listErr) { console.error('[wipe-test-data] listUsers failed:', listErr); break }
      for (const u of pageData.users) {
        if (!adminIds.includes(u.id)) stray.push({ id: u.id, email: u.email ?? '(no email)' })
      }
      if (pageData.users.length < 200) break
      page++
    }
    return stray
  }

  if (dryRun) {
    const strayPreview = await findStrayAuthUsers()
    return NextResponse.json({
      dry_run: true,
      would_delete_count: targets?.length ?? 0,
      would_delete_emails: (targets ?? []).map(t => t.email),
      would_survive: (survivors ?? []).map(s => s.email),
      // Present in auth.users but with no matching profiles row — these
      // wouldn't show up anywhere in /admin/users, so surfacing them here
      // specifically rather than folding them silently into the count
      // above.
      stray_auth_users_not_in_profiles: strayPreview.map(s => s.email),
      note: 'Nothing was deleted. Re-call with { "confirm": "' + CONFIRM_PHRASE + '", "dry_run": false } to actually run this.',
    })
  }

  const targetIds = targets.map(t => t.id)

  // Step 1: clean up live Geonode sub-users before touching any local
  // rows — skipping this would leave real, billable sub-users orphaned
  // on Geonode's side with nothing locally left to find or clean them up
  // once the DB rows are gone. Swept by "not admin" rather than "owned by
  // a current target", same reasoning as every other table below: a
  // credential can be orphaned (owner profile already gone) and still
  // have a live, billable Geonode sub-user behind it.
  const { data: allCreds } = await supabase
    .from('proxy_credentials')
    .select('id, geonode_sub_user_id, user_id')
    .not('geonode_sub_user_id', 'is', null)

  let geonodeCleanedUp = 0
  const geonodeFailures: string[] = []
  for (const cred of allCreds ?? []) {
    if (!cred.geonode_sub_user_id) continue
    if (adminIds.includes(cred.user_id)) continue // admin's own — not test data, leave it
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
  // investigation above. Deliberately "not admin" rather than "owned by
  // a current target": scoping to targetIds (accounts that still have a
  // profiles row right now) misses rows belonging to accounts that were
  // already fully gone from profiles before this ever ran — orphaned
  // orders being the concrete case that surfaced this. "Not admin" has
  // no such blind spot; it can't miss a row just because the account
  // behind it is already gone.
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
    const query = adminIds.length > 0
      ? supabase.from(table).delete().not('user_id', 'in', `(${adminIds.join(',')})`)
      : supabase.from(table).delete().neq('user_id', '00000000-0000-0000-0000-000000000000') // no admin at all — wipe unconditionally
    const { error } = await query
    if (error) {
      console.error(`[wipe-test-data] Failed to clear ${table}:`, error)
      tableErrors[table] = error.message
    }
  }

  // proxy_credentials.created_by can point at a deleted account even on a
  // row owned (user_id) by admin, or by an already-orphaned account this
  // sweep never directly enumerated — nulled out by the same "not admin"
  // rule rather than scoped to targetIds, for the same reason as above.
  const createdByQuery = adminIds.length > 0
    ? supabase.from('proxy_credentials').update({ created_by: null }).not('created_by', 'in', `(${adminIds.join(',')})`)
    : supabase.from('proxy_credentials').update({ created_by: null }).not('created_by', 'is', null)
  const { error: createdByErr } = await createdByQuery
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

  // Step 6: sweep auth.users directly for anything left over — see
  // findStrayAuthUsers() above for what this catches and why.
  const strayAuthUsers = await findStrayAuthUsers()

  let strayAuthDeleted = 0
  const strayAuthFailures: { email: string; error: string }[] = []
  for (const u of strayAuthUsers) {
    const { error } = await supabase.auth.admin.deleteUser(u.id)
    if (!error) strayAuthDeleted++
    else if (!/not found/i.test(error.message)) strayAuthFailures.push({ email: u.email, error: error.message })
  }

  return NextResponse.json({
    success: !profilesErr && authFailures.length === 0 && Object.keys(tableErrors).length === 0 && strayAuthFailures.length === 0,
    profiles_deleted: profilesDeleted ?? 0,
    profiles_clear_error: profilesErr?.message ?? null,
    auth_users_deleted: authDeletedCount,
    auth_users_already_gone: alreadyGoneCount, // orphaned-row cases — expected, not a problem
    auth_delete_failures: authFailures,
    stray_auth_users_found: strayAuthUsers.length, // had no matching profiles row at all
    stray_auth_users_deleted: strayAuthDeleted,
    stray_auth_failures: strayAuthFailures,
    child_table_errors: tableErrors, // should be {} — any key here means that table didn't fully clear
    geonode_cleaned_up: geonodeCleanedUp,
    geonode_failures: geonodeFailures,
    transfers_clear_error: transfersErr?.message ?? null,
    banned_emails_clear_error: bannedErr?.message ?? null,
    created_by_clear_error: createdByErr?.message ?? null,
    survivors: (survivors ?? []).map(s => s.email),
  })
}
