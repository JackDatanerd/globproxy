import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
type Drift = { user_id: string; allocated_gb: number; expected_gb: number; drift_gb: number }

// createCredential() reserves GB before the provider call and the row insert; a Worker killed in
// that window leaks the reservation and nothing used to notice. allocation_drift() (migration 0113)
// lists accounts whose reserved GB exceeds what their sessions plus archived usage explain. A create
// in flight shows up for a few seconds, so the list is read twice, SETTLE_MS apart, and only accounts
// whose drift is unchanged are reported. Read-only: the admin decides how to repair an account.
const SETTLE_MS = 30_000

async function readDrift(admin: Admin): Promise<Drift[]> {
  const { data, error } = await admin.rpc('allocation_drift')
  if (error) throw error
  return ((data ?? []) as any[]).map((r) => ({
    user_id: String(r.user_id), allocated_gb: Number(r.allocated_gb), expected_gb: Number(r.expected_gb), drift_gb: Number(r.drift_gb),
  }))
}

export async function reportAllocationDrift(admin?: Admin, settleMs = SETTLE_MS): Promise<{ drifted: number; reported: number; error?: string }> {
  try {
    const db = admin ?? await createAdminClient()
    const first = await readDrift(db)
    if (!first.length) return { drifted: 0, reported: 0 }
    await new Promise((r) => setTimeout(r, settleMs))
    const second = await readDrift(db)
    const before = new Map(first.map((d) => [d.user_id, d.drift_gb]))
    const stable = second.filter((d) => before.get(d.user_id) === d.drift_gb)
    if (!stable.length) return { drifted: second.length, reported: 0 }

    for (const d of stable) console.error('[allocation-drift] reserved GB not explained by sessions', d)
    if (process.env.ADMIN_EMAIL) {
      const rows = stable.slice(0, 20).map((d) =>
        `<li>${escapeHtml(d.user_id)}: reserved ${d.allocated_gb.toFixed(4)} GB, sessions + archived usage ${d.expected_gb.toFixed(4)} GB, unexplained ${d.drift_gb.toFixed(4)} GB</li>`).join('')
      await sendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: `[ALLOCATION DRIFT] ${stable.length} account(s) have bandwidth reserved that no session accounts for`,
        html: `<p>These accounts hold reserved bandwidth that no session or archived usage explains, unchanged across two reads.
               It is usually a session create interrupted after the reservation (the customer cannot spend that GB).
               Nothing was changed automatically.</p><ul>${rows}</ul>`,
      }).catch((e) => console.error('[allocation-drift] admin email failed', e))
    }
    return { drifted: second.length, reported: stable.length }
  } catch (e) {
    console.error('[allocation-drift] check failed', e)
    return { drifted: 0, reported: 0, error: 'allocation_drift_check_failed' }
  }
}
