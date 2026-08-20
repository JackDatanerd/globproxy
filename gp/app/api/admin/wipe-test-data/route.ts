import { createAdminClient } from '@/lib/supabase/server'
import { deleteSubUser } from '@/lib/geonode'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// One-time pre-launch cleanup — hard-deletes every non-admin account, for
// clearing out QA/test data before going live. Deliberately NOT the same
// path as /api/admin/delete-user, which soft-deletes (anonymises +
// permanently bans, keeps the row) by design — that route exists for real
// customer deletions where financial/audit records need to survive, and
// its own comments explain exactly why it avoids auth.admin.deleteUser():
// reseller_transfers has no ON DELETE CASCADE on either of its foreign
// keys, so calling that against an account with transfer history throws a
// raw FK violation and blocks the delete outright.
//
// This route is for the opposite case — genuinely wiping test data, where
// there's nothing worth preserving — so it clears reseller_transfers and
// banned_emails first (both pure test artifacts, nothing else references
// them), which removes that blocker and lets auth.admin.deleteUser()
// cascade cleanly through profiles -> bandwidth_accounts, orders,
// proxy_credentials, proxy_sessions, api_keys, webhook_endpoints, and the
// three mfa_* tables (all ON DELETE CASCADE from profiles.id, which is
// itself ON DELETE CASCADE from auth.users.id).
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

  // Step 1: clean up live Geonode sub-users before touching any local
  // rows — same reasoning as delete-user's own step 1. Skipping this
  // would leave real, billable sub-users orphaned on Geonode's side with
  // nothing locally left to find or clean them up once the DB rows are
  // gone.
  let geonodeCleanedUp = 0
  const geonodeFailures: string[] = []
  for (const t of targets) {
    const { data: creds } = await supabase
      .from('proxy_credentials')
      .select('id, geonode_sub_user_id')
      .eq('user_id', t.id)
      .not('geonode_sub_user_id', 'is', null)

    for (const cred of creds ?? []) {
      if (!cred.geonode_sub_user_id) continue
      try {
        await deleteSubUser(cred.geonode_sub_user_id)
        geonodeCleanedUp++
      } catch (e) {
        console.error('[wipe-test-data] Geonode cleanup failed for', cred.id, e)
        geonodeFailures.push(cred.id)
      }
    }
  }

  // Step 2: clear the two tables that don't cascade from profiles, which
  // would otherwise block every deleteUser() call below with a raw FK
  // violation the moment any of these test accounts shows up in either
  // table's history.
  const { error: transfersErr } = await supabase.from('reseller_transfers').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  if (transfersErr) console.error('[wipe-test-data] Failed to clear reseller_transfers:', transfersErr)

  const { error: bannedErr } = await supabase.from('banned_emails').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  if (bannedErr) console.error('[wipe-test-data] Failed to clear banned_emails:', bannedErr)

  // Step 3: delete each auth user. This is the real deletion — cascades
  // through profiles and everything ON DELETE CASCADE from it.
  let deletedCount = 0
  const deleteFailures: { email: string; error: string }[] = []
  for (const t of targets) {
    const { error } = await supabase.auth.admin.deleteUser(t.id)
    if (error) {
      console.error('[wipe-test-data] Failed to delete', t.email, error.message)
      deleteFailures.push({ email: t.email, error: error.message })
    } else {
      deletedCount++
    }
  }

  return NextResponse.json({
    success: deleteFailures.length === 0,
    deleted_count: deletedCount,
    delete_failures: deleteFailures,
    geonode_cleaned_up: geonodeCleanedUp,
    geonode_failures: geonodeFailures,
    survivors: (survivors ?? []).map(s => s.email),
  })
}
