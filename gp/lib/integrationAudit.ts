import { createAdminClient } from '@/lib/supabase/server'
import { logSecurityEvent, notifySecurityChange, type SecurityEventType } from '@/lib/securityEvents'
import { escapeHtml } from '@/lib/email'

// Audit trail + owner notice for webhook-endpoint changes, shared by the
// dashboard routes and /api/v1/webhooks/*.
//
// Why it exists: a webhook endpoint is a standing channel for the account's
// event data, and "point the endpoint somewhere else" is exactly what someone
// holding a leaked API key would do. The dashboard asks for a 2FA step-up and
// e-mails the owner; the API (which cannot do a step-up) did neither, so the
// change left no trace beyond the api_request_log. Every route now calls this.
//
// The e-mail is throttled so a key looping on the endpoint can't turn the owner's
// inbox into a cannon; the security_events row is written every time. The throttle
// is per event type AND per origin (dashboard vs. which API key, and which host):
// a flat per-event window let a legitimate edit made a minute earlier silence the
// notice for a different actor's change, which is the one the owner needs to see.
// Repeats of the SAME origin are held to one notice per window, and one origin
// pair can't exceed MAX_NOTICES_PER_WINDOW notices however many hosts it cycles.
type WebhookAuditEvent = Extract<SecurityEventType, 'webhook_created' | 'webhook_updated' | 'webhook_deleted' | 'webhook_secret_rotated'>

const NOTICE_WINDOW_MS = 10 * 60_000
const MAX_NOTICES_PER_WINDOW = 5

const COPY: Record<WebhookAuditEvent, { heading: string; detail: (via: string, host: string | null) => string }> = {
  webhook_created: {
    heading: 'A new webhook endpoint was added to your GlobProxy account',
    detail: (via, host) => `a new webhook endpoint${host ? ` (<strong>${escapeHtml(host)}</strong>)` : ''} was just added ${via}. Account events will be delivered to it.`,
  },
  webhook_updated: {
    heading: 'A webhook endpoint on your GlobProxy account was changed',
    detail: (via, host) => `a webhook endpoint${host ? ` (<strong>${escapeHtml(host)}</strong>)` : ''} was just changed ${via} — its address, subscribed events or on/off state.`,
  },
  webhook_deleted: {
    heading: 'A webhook endpoint was deleted from your GlobProxy account',
    detail: (via) => `a webhook endpoint was just deleted ${via}.`,
  },
  webhook_secret_rotated: {
    heading: 'A webhook signing secret on your GlobProxy account was rotated',
    detail: (via) => `the signing secret of a webhook endpoint was just rotated ${via}.`,
  },
}

export function hostOf(url: unknown): string | null {
  try { return typeof url === 'string' ? new URL(url).hostname : null } catch { return null }
}

export async function auditWebhookChange(p: {
  userId: string
  event: WebhookAuditEvent
  req: Request
  via: 'api' | 'dashboard'
  webhookId?: string | null
  host?: string | null
  keyId?: string | null
  changed?: string[]
}): Promise<void> {
  try {
    const admin = await createAdminClient()
    const since = new Date(Date.now() - NOTICE_WINDOW_MS).toISOString()
    const { data: recent, error: recentErr } = await admin.from('security_events')
      .select('meta')
      .eq('user_id', p.userId).eq('event', p.event).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(50)
    // Reading the window failed: err on the side of telling the owner rather than staying silent.
    const rows = recentErr ? [] : (recent ?? [])
    const sameVia = rows.filter((r: any) => r?.meta?.via === p.via)
    const sameOrigin = sameVia.some((r: any) =>
      (r?.meta?.key_id ?? null) === (p.keyId ?? null) && (r?.meta?.host ?? null) === (p.host ?? null))
    const throttled = sameOrigin || sameVia.length >= MAX_NOTICES_PER_WINDOW
    await logSecurityEvent({
      userId: p.userId, event: p.event, req: p.req, admin,
      meta: { via: p.via, webhook_id: p.webhookId ?? null, host: p.host ?? null, key_id: p.keyId ?? null, ...(p.changed ? { changed: p.changed } : {}) },
    })
    if (throttled) return
    const copy = COPY[p.event]
    await notifySecurityChange(p.userId, copy.heading, copy.detail(p.via === 'api' ? 'with an API key' : 'from your dashboard', p.host ?? null))
  } catch (e) {
    console.error('[integration-audit] failed', p.event, e)
  }
}
