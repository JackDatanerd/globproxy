import { createAdminClient } from '@/lib/supabase/server'
import { getSubUserUsage } from '@/lib/geonode'
import { computeStockStatus } from '@/lib/stockStatus'
import { sendEmail } from '@/lib/email'
import { NextResponse } from 'next/server'

// Secured with CRON_SECRET env var
// Set this in Cloudflare Workers env vars and wrangler.jsonc
function validateCron(req: Request): boolean {
  const secret = req.headers.get('x-cron-secret') ?? ''
  const expected = process.env.CRON_SECRET ?? ''
  if (!expected) return false
  const crypto = require('crypto')
  const a = Buffer.from(secret)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// ── Stock check ──────────────────────────────────────────────────
async function runStockCheck() {
  const supabase = await createAdminClient()
  const stock = await computeStockStatus(supabase)

  await supabase.from('platform_settings')
    .upsert({ key: 'geonode_stock', value: JSON.stringify(stock) }, { onConflict: 'key' })

  // Two distinct alert conditions — either can fire independently:
  // 1. Exposure alert: stock can't cover what's currently promised to
  //    customers if they all drew down at once. This is the one that
  //    actually matters for a usage-based model.
  // 2. Absolute floor alert: stock is just low in absolute terms, kept as a
  //    simple backstop regardless of exposure math.
  const threshold = Number(process.env.STOCK_ALERT_THRESHOLD ?? 10)
  const exposureBreach = !stock.covered
  const floorBreach = stock.available_gb <= threshold

  if (exposureBreach || floorBreach) {
    const subject = exposureBreach
      ? `[EXPOSURE ALERT] Stock (${stock.available_gb.toFixed(1)}GB) can't cover what's sold (${stock.exposure_gb.toFixed(1)}GB unused-but-allocated)`
      : `[LOW STOCK] Geonode bandwidth: ${stock.available_gb.toFixed(1)}GB remaining`
    await sendEmail({
      to: process.env.ADMIN_EMAIL!,
      subject,
      html: `<p><strong>Available:</strong> ${stock.available_gb.toFixed(1)}GB of ${stock.total_gb.toFixed(1)}GB total</p>
             <p><strong>Allocated to customers:</strong> ${stock.total_allocated_gb.toFixed(1)}GB</p>
             <p><strong>Actually used so far:</strong> ${stock.total_used_gb.toFixed(1)}GB</p>
             <p><strong>Exposure (allocated but not yet used):</strong> ${stock.exposure_gb.toFixed(1)}GB</p>
             ${exposureBreach ? '<p style="color:#e24b4a"><strong>If customers drew down their full remaining allocation right now, you would run short.</strong></p>' : ''}
             <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/settings">Go to Admin Panel →</a></p>`,
    })
    return { action: 'alert_sent', ...stock }
  }
  return { action: 'ok', ...stock }
}

// ── Usage sync ───────────────────────────────────────────────────
async function runUsageSync() {
  const supabase = await createAdminClient()
  const { data: creds } = await supabase
    .from('proxy_credentials')
    .select('id, geonode_sub_user_id, gb_used, user_id')
    .eq('status', 'active')
    .not('geonode_sub_user_id', 'is', null)

  let updated = 0
  for (const cred of creds ?? []) {
    try {
      // Geonode's usage endpoint takes the sub-user ID, not the username —
      // this was passing geonode_username before, which never matched.
      const newUsed = await getSubUserUsage(cred.geonode_sub_user_id)
      if (Math.abs(newUsed - (cred.gb_used ?? 0)) > 0.001) {
        await supabase.from('proxy_credentials').update({ gb_used: newUsed }).eq('id', cred.id)
        updated++
      }
    } catch {}
  }

  // Recalculate bandwidth_accounts per user
  const { data: accounts } = await supabase.from('bandwidth_accounts').select('user_id')
  for (const acc of accounts ?? []) {
    const { data: userCreds } = await supabase
      .from('proxy_credentials')
      .select('gb_used')
      .eq('user_id', acc.user_id)
      .eq('status', 'active')
    const totalUsed = userCreds?.reduce((s, c) => s + (c.gb_used ?? 0), 0) ?? 0
    await supabase.from('bandwidth_accounts').update({ used_gb: totalUsed }).eq('user_id', acc.user_id)
  }

  return { updated_credentials: updated }
}

// ── User bandwidth alerts ─────────────────────────────────────────
// Each account only ever gets ONE email per threshold (80%, 95%) until
// a top-up moves them back below that threshold, at which point the
// corresponding alerted_*_at flag is cleared and they can be alerted
// again on the next approach. Previously there was no de-dupe at all,
// so any account sitting above a threshold got a fresh email on every
// cron run (e.g. every 15 minutes) indefinitely.
async function runBandwidthAlerts() {
  const supabase = await createAdminClient()
  const { data: accounts } = await supabase
    .from('bandwidth_accounts')
    .select('user_id, total_gb, used_gb, available_gb, alerted_80_at, alerted_95_at')
    .gt('total_gb', 0)

  let sent = 0
  for (const acc of accounts ?? []) {
    if (!acc.total_gb) continue
    const pct = (acc.used_gb / acc.total_gb) * 100

    // Below 80% — clear any stale alert flags so a future approach re-alerts.
    if (pct < 80) {
      if (acc.alerted_80_at || acc.alerted_95_at) {
        await supabase.from('bandwidth_accounts')
          .update({ alerted_80_at: null, alerted_95_at: null })
          .eq('user_id', acc.user_id)
      }
      continue
    }

    const { data: profile } = await supabase
      .from('profiles').select('email, full_name').eq('id', acc.user_id).single()
    if (!profile?.email) continue

    const firstName = profile.full_name?.split(' ')[0] ?? 'there'
    const avail = acc.available_gb

    if (pct >= 95 && !acc.alerted_95_at) {
      await sendEmail({
        to: profile.email,
        subject: `🚨 Only ${avail.toFixed(1)}GB remaining — GlobProxy`,
        html: `<p>Hi ${firstName}, you've used ${pct.toFixed(0)}% of your bandwidth. Only ${avail.toFixed(1)}GB remains.</p>
               <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/buy">Top up now →</a>`,
      })
      await supabase.from('bandwidth_accounts')
        .update({ alerted_95_at: new Date().toISOString() })
        .eq('user_id', acc.user_id)
      sent++
    } else if (pct >= 80 && pct < 95 && !acc.alerted_80_at) {
      await sendEmail({
        to: profile.email,
        subject: `Heads up: ${avail.toFixed(1)}GB bandwidth remaining`,
        html: `<p>Hi ${firstName}, you've used ${pct.toFixed(0)}% of your bandwidth. ${avail.toFixed(1)}GB remains.</p>
               <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/buy">Buy more →</a>`,
      })
      await supabase.from('bandwidth_accounts')
        .update({ alerted_80_at: new Date().toISOString() })
        .eq('user_id', acc.user_id)
      sent++
    }
  }
  return { alerts_sent: sent }
}

// ── Daily summary ─────────────────────────────────────────────────
async function runDailySummary() {
  const supabase = await createAdminClient()
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
  const today = new Date().toISOString().split('T')[0]

  const { data: orders } = await supabase.from('orders')
    .select('amount_usd, gb_amount')
    .eq('payment_status', 'paid')
    .gte('paid_at', `${yesterday}T00:00:00Z`)
    .lt('paid_at', `${today}T00:00:00Z`)

  const rev = orders?.reduce((s, o) => s + o.amount_usd, 0) ?? 0
  const gb = orders?.reduce((s, o) => s + o.gb_amount, 0) ?? 0

  const { count: newUsers } = await supabase.from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', `${yesterday}T00:00:00Z`)

  await sendEmail({
    to: process.env.ADMIN_EMAIL!,
    subject: `GlobProxy Daily Summary — ${yesterday}`,
    html: `<div style="font-family:sans-serif">
      <h2 style="color:#0057ff">Daily Summary — ${yesterday}</h2>
      <p><strong>Revenue:</strong> $${rev.toFixed(2)}</p>
      <p><strong>GB sold:</strong> ${gb.toFixed(1)} GB</p>
      <p><strong>Orders:</strong> ${orders?.length ?? 0}</p>
      <p><strong>New users:</strong> ${newUsers ?? 0}</p>
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin">Open admin panel →</a>
    </div>`,
  })
  return { revenue: rev, gb_sold: gb, new_users: newUsers }
}

// ── Cleanup stale orders ──────────────────────────────────────────
async function runCleanup() {
  const supabase = await createAdminClient()
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: stale } = await supabase.from('orders')
    .select('id').eq('payment_status', 'pending').lt('created_at', cutoff)

  for (const o of stale ?? []) {
    await supabase.from('orders').update({ payment_status: 'failed' }).eq('id', o.id)
  }
  return { cleaned: stale?.length ?? 0 }
}

// ── Route handler ─────────────────────────────────────────────────
export async function POST(req: Request, context: { params: Promise<{ task: string }> }) {
  if (!validateCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { task } = await context.params
  try {
    let result
    switch (task) {
      case 'stock':   result = await runStockCheck();       break
      case 'usage':   result = await runUsageSync();        break
      case 'alerts':  result = await runBandwidthAlerts();  break
      case 'summary': result = await runDailySummary();     break
      case 'cleanup': result = await runCleanup();          break
      default: return NextResponse.json({ error: `Unknown task: ${task}` }, { status: 400 })
    }
    return NextResponse.json({ task, result, timestamp: new Date().toISOString() })
  } catch (err: any) {
    console.error(`Cron task ${task} failed:`, err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// Also support GET for manual triggering from browser (admin only)
export async function GET(req: Request, context: { params: Promise<{ task: string }> }) {
  return POST(req, context)
}
