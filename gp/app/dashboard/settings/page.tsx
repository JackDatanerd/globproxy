'use client'
import { useState, useEffect, useRef, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import TwoFactorSettings from '@/components/dashboard/TwoFactorSettings'
import { ChangePasswordCard, ChangeEmailCard, SecurityActivityCard, ActiveSessionsCard } from '@/components/dashboard/AccountSecurityCards'
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS, WEBHOOK_WILDCARD } from '@/lib/webhookEvents'
import { apiFetch, apiJson, copyText, redirectToMfa, saveBlob, hasAtMostDecimals, toastApiError } from '@/lib/clientApi'
import { fetchCountryList } from '@/lib/geoTargeting'
import { fetchWithReauth } from '@/lib/reauthPrompt'
import { formatGb } from '@/lib/format'
import NumberField from '@/components/dashboard/NumberField'



const VOLUME_OPTIONS = [
  'Under 10 GB / month',
  '10 – 50 GB / month',
  '50 – 200 GB / month',
  '200 GB – 1 TB / month',
  'Over 1 TB / month',
]

function SettingsPageInner() {
  const router = useRouter()
  const [profile, setProfile] = useState<any>(null)
  const [form, setForm] = useState({ full_name: '', company_name: '' })
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Delete-account panel: replaces two back-to-back confirm() dialogs with a
  // typed confirmation that spells out what is lost.
  const [showDelete, setShowDelete] = useState(false)
  const [deleteText, setDeleteText] = useState('')
  // Cool-off: when set, the account is scheduled for deletion (migration 0075) and can be cancelled.
  const [deletionScheduledAt, setDeletionScheduledAt] = useState<string | null>(null)
  const [cancellingDeletion, setCancellingDeletion] = useState(false)
  const [deleteFacts, setDeleteFacts] = useState<{ remainingGb: number; sessions: number; unpaidEarningsUsd: number } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  // Reseller application country list: the same ~210-country dataset the proxy
  // forms use (a hard-coded 88-name list left out e.g. Rwanda, DR Congo, Hong Kong).
  // If it can't load, the field falls back to free text rather than blocking applicants.
  const [countryNames, setCountryNames] = useState<string[] | null>(null)
  const [countryLoadFailed, setCountryLoadFailed] = useState(false)

  // Default auto-allocate
  const [defaultAuto, setDefaultAuto] = useState({ enabled: false, threshold_gb: 1, amount_gb: 5 })
  const [defaultAutoLoading, setDefaultAutoLoading] = useState(false)

  // Webhooks
  const [webhooks, setWebhooks] = useState<any[]>([])
  const [webhooksLoading, setWebhooksLoading] = useState(true)
  const [webhooksError, setWebhooksError] = useState<string | null>(null)
  // In-place editing of an endpoint's URL / events (PATCH already supported
  // both; the UI only ever offered enable/disable).
  const [editingWebhookId, setEditingWebhookId] = useState<string | null>(null)
  const [editUrl, setEditUrl] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editEvents, setEditEvents] = useState<string[]>([])
  const [savingWebhook, setSavingWebhook] = useState(false)
  const [newWebhookUrl, setNewWebhookUrl] = useState('')
  const [newWebhookDesc, setNewWebhookDesc] = useState('')
  const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>(['session_created', 'bandwidth_threshold_crossed', 'bandwidth_exhausted'])
  const [creatingWebhook, setCreatingWebhook] = useState(false)
  // Shown exactly once, right after creation — the API never returns the
  // secret again after this response (see app/api/dashboard/webhooks/route.ts).
  // Carries the endpoint URL so the banner says WHICH secret this is.
  const [revealedSecret, setRevealedSecret] = useState<{ url: string; secret: string } | null>(null)
  // Inline rotate panel (replaces two back-to-back confirm() dialogs, where
  // dismissing the second one — Esc, or closing the box — silently chose
  // "revoke the old secret immediately").
  const [rotatingWebhookId, setRotatingWebhookId] = useState<string | null>(null)
  const [rotateGrace, setRotateGrace] = useState<'1440' | '0'>('1440')
  const [rotatingSecret, setRotatingSecret] = useState(false)
  const [lowEmails, setLowEmails] = useState(true)
  // Product news & offers (broadcasts). Default ON; every such e-mail also carries a one-click unsubscribe link.
  const [marketingEmails, setMarketingEmails] = useState(true)
  const [savingMarketing, setSavingMarketing] = useState(false)
  const [warnPct, setWarnPct] = useState('80')
  const [urgentPct, setUrgentPct] = useState('95')
  const [savingPcts, setSavingPcts] = useState(false)
  const [savingLowEmails, setSavingLowEmails] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  // Delivery log: one endpoint's log open at a time.
  const [logId, setLogId] = useState<string | null>(null)
  const [logRows, setLogRows] = useState<any[]>([])
  const [logNext, setLogNext] = useState<{ before: string; id: string | null } | null>(null) // cursor (next_before + next_before_id) for older deliveries
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<any | null>(null)
  const detailReqRef = useRef(0) // tags each details request so a slow earlier one can't overwrite a later one
  const [logLoading, setLogLoading] = useState(false)

  // Reseller application form state
  const [applying, setApplying] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [appForm, setAppForm] = useState({
    full_name: '',
    country: '',
    phone: '',
    monthly_volume: '',
  })

  useEffect(() => {
    if (!showForm || countryNames || countryLoadFailed) return
    fetchCountryList()
      .then(l => setCountryNames(l.map(c => c.name).sort((a, b) => a.localeCompare(b))))
      .catch(() => setCountryLoadFailed(true))
  }, [showForm, countryNames, countryLoadFailed])

  async function loadWebhooks() {
    setWebhooksLoading(true)
    try {
      const d = await apiFetch('/api/dashboard/webhooks')
      setWebhooks(d.webhooks ?? [])
      setWebhooksError(null)
    } catch (e: any) {
      // Used to be swallowed: a failed load looked identical to "No webhooks yet".
      setWebhooksError(e?.message || 'Couldn\u2019t load your webhooks')
    } finally {
      setWebhooksLoading(false)
    }
  }

  useEffect(() => {
    const sb = createClient()
    sb.auth.getUser().then(async ({ data: { user } }) => {
      // No session (or getUser failing, see .catch below) used to leave the page
      // on its loading skeleton forever with no message.
      if (!user) { setProfileError('Couldn\u2019t load your profile. Refresh the page to try again.'); return }
      // Only the columns this page uses — `select('*')` also pulled payout
      // bank details and application JSON into component state.
      const { data, error } = await sb.from('profiles')
        .select('id, email, full_name, company_name, role, reseller_status')
        .eq('id', user.id).single()
      if (error || !data) { setProfileError('Couldn\u2019t load your profile. Refresh the page to try again.'); return }
      setProfile(data)
      setForm({ full_name: data?.full_name ?? '', company_name: data?.company_name ?? '' })
      // Pre-fill name if available
      if (data?.full_name) setAppForm(f => ({ ...f, full_name: data.full_name }))

      const { data: bw } = await sb.from('bandwidth_accounts')
        .select('default_auto_topup_enabled, default_auto_topup_threshold_gb, default_auto_topup_amount_gb, total_gb, used_gb')
        .eq('user_id', user.id).maybeSingle()
      if (bw) {
        setDefaultAuto({
          enabled: bw.default_auto_topup_enabled ?? false,
          threshold_gb: bw.default_auto_topup_threshold_gb ?? 1,
          amount_gb: bw.default_auto_topup_amount_gb ?? 5,
        })
      }
      const { count } = await sb.from('proxy_credentials').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
      // Affiliate earnings not yet paid out are forfeited too (scrub_affiliate_data).
      // Best-effort: a failed read just hides the line.
      const { data: unpaid } = await sb.from('affiliate_commissions').select('commission_amount_usd')
        .eq('referrer_id', user.id).eq('status', 'pending')
      const unpaidEarningsUsd = (unpaid ?? []).reduce((t: number, r: any) => t + Number(r.commission_amount_usd ?? 0), 0)
      setDeleteFacts({ remainingGb: Math.max(0, (bw?.total_gb ?? 0) - (bw?.used_gb ?? 0)), sessions: count ?? 0, unpaidEarningsUsd })

      // Separate and tolerant: if migration 0063 isn't applied yet this errors,
      // and the page must still load (the toggle then just shows its default).
      const { data: prefs } = await sb.from('profiles').select('low_bandwidth_emails').eq('id', user.id).maybeSingle()
      if (prefs && typeof (prefs as any).low_bandwidth_emails === 'boolean') setLowEmails((prefs as any).low_bandwidth_emails)
      // Tolerant like the line above (migration 0108): if it errors the toggle just shows its default.
      const { data: mk } = await sb.from('profiles').select('marketing_emails').eq('id', user.id).maybeSingle()
      if (mk && typeof (mk as any).marketing_emails === 'boolean') setMarketingEmails((mk as any).marketing_emails)
      // Alert levels (migration 0086) — tolerant for the same reason: defaults stay if it errors.
      const { data: lv } = await sb.from('profiles').select('usage_warn_pct, usage_urgent_pct').eq('id', user.id).maybeSingle()
      if (lv && (lv as any).usage_warn_pct != null) { setWarnPct(String((lv as any).usage_warn_pct)); setUrgentPct(String((lv as any).usage_urgent_pct)) }
      // Tolerant for the same reason (migration 0075).
      const { data: sched } = await sb.from('profiles').select('deletion_scheduled_at').eq('id', user.id).maybeSingle()
      if (sched && (sched as any).deletion_scheduled_at) setDeletionScheduledAt((sched as any).deletion_scheduled_at)
    }).catch(() => setProfileError('Couldn\u2019t load your profile. Refresh the page to try again.'))

    loadWebhooks()
  }, [])

  const searchParams = useSearchParams()
  useEffect(() => {
    if (searchParams.get('apply_reseller') === '1') setShowForm(true)
    // /auth/callback sends a completed e-mail change here. Say so once, then
    // drop the param so a refresh doesn't repeat it.
    const emailResult = searchParams.get('success')
    if (emailResult === 'email_updated' || emailResult === 'email_pending') {
      if (emailResult === 'email_updated') toast.success('Your sign-in email was updated.')
      else toast('Link confirmed. The change applies once the other address confirms too — check both inboxes.', { icon: '✉️', duration: 7000 })
      try {
        const u = new URL(window.location.href)
        u.searchParams.delete('success')
        window.history.replaceState(null, '', u.pathname + u.search + u.hash)
      } catch { /* cosmetic only */ }
    }
  }, [searchParams])

  async function toggleLowEmails(next: boolean) {
    if (savingLowEmails || !profile) return
    setSavingLowEmails(true)
    const prev = lowEmails
    setLowEmails(next) // optimistic; rolled back on failure
    const { error } = await createClient().from('profiles').update({ low_bandwidth_emails: next }).eq('id', profile.id)
    setSavingLowEmails(false)
    if (error) { setLowEmails(prev); toast.error('Couldn\u2019t save that preference. Please try again.'); return }
    toast.success(next ? 'Low-bandwidth e-mails on' : 'Low-bandwidth e-mails off')
  }

  async function toggleMarketing(next: boolean) {
    if (savingMarketing || !profile) return
    setSavingMarketing(true)
    const prev = marketingEmails
    setMarketingEmails(next) // optimistic; rolled back on failure
    const { error } = await createClient().from('profiles').update({ marketing_emails: next }).eq('id', profile.id)
    setSavingMarketing(false)
    if (error) { setMarketingEmails(prev); toast.error('Couldn\u2019t save that preference. Please try again.'); return }
    toast.success(next ? 'Product news & offers on' : 'Product news & offers off')
  }

  async function saveAlertLevels() {
    if (savingPcts || !profile) return
    const warn = Number(warnPct), urgent = Number(urgentPct)
    // Same rules as the database constraint (migration 0086).
    if (!Number.isInteger(warn) || !Number.isInteger(urgent) || warn < 50 || warn > 98 || urgent < 51 || urgent > 99 || warn >= urgent) {
      toast.error('Use whole numbers: the first alert between 50 and 98, the second higher than it and at most 99.')
      return
    }
    setSavingPcts(true)
    const { error } = await createClient().from('profiles').update({ usage_warn_pct: warn, usage_urgent_pct: urgent }).eq('id', profile.id)
    setSavingPcts(false)
    if (error) { toast.error('Couldn\u2019t save those alert levels. Please try again.'); return }
    toast.success('Alert levels saved')
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return // not loaded yet (or failed to load) — nothing to save against
    const clean = { full_name: form.full_name.trim().slice(0, 100), company_name: form.company_name.trim().slice(0, 100) }
    if (!clean.full_name) { toast.error('Please enter your name'); return }
    setLoading(true)
    const { error } = await createClient().from('profiles').update({ ...clean, company_name: clean.company_name || null }).eq('id', profile.id)
    if (error) toast.error('Couldn\u2019t save your profile. Please try again.')
    else { toast.success('Profile updated'); setForm(clean) }
    setLoading(false)
  }

  // Hits app/api/user/delete-account. One-way anonymisation, so the UI makes
  // the person type DELETE after reading what is actually lost (it used to be
  // two reflexive confirm() popups that said nothing about remaining GB).
  async function deleteAccount() {
    if (deleteText.trim().toUpperCase() !== 'DELETE') return
    setDeleting(true)
    try {
      // Always scheduled (7-day cool-off, cancellable); there is no immediate option.
      const res: any = await apiJson('DELETE', '/api/user/delete-account', {})
      if (res?.scheduled) {
        setDeletionScheduledAt(res.scheduled_at ?? null)
        setShowDelete(false); setDeleteText('')
        toast.success('Deletion scheduled — we have emailed you how to cancel it')
        setDeleting(false)
        router.refresh() // the dashboard layout's "scheduled for deletion" banner is server-rendered
        return
      }
      // The route only ever schedules; anything else is an unexpected answer.
      toast.error('We could not schedule the deletion. Please try again.')
      setDeleting(false)
    } catch (err: any) {
      toastApiError(err, 'Failed to delete account')
      setDeleting(false)
    }
  }

  async function cancelDeletion() {
    setCancellingDeletion(true)
    try {
      const res: any = await apiJson('POST', '/api/user/delete-account/cancel')
      setDeletionScheduledAt(null)
      if (res?.sessions_released) toast('Deletion cancelled. Some proxy sessions were already removed and cannot be restored — your unused bandwidth is back in your balance.', { duration: 9000 })
      else toast.success('Deletion cancelled — your account stays as it is')
      router.refresh() // drop the layout's red banner, which would otherwise stay until a reload
    } catch (err: any) {
      toastApiError(err, 'Could not cancel the deletion')
    }
    setCancellingDeletion(false)
  }

  // GET /api/user/export — same step-up as deletion (password / authenticator prompt).
  async function downloadMyData() {
    setExporting(true)
    try {
      const res = await fetchWithReauth('/api/user/export')
      if (!res.ok) {
        const data: any = await res.json().catch(() => ({}))
        if (res.status === 403 && data?.code === 'mfa_required') { redirectToMfa(data); return }
        if (res.status === 403 && data?.code === 'reauth_required') return   // confirmation declined
        throw new Error(data?.error || `Export failed (${res.status})`)
      }
      saveBlob(await res.blob(), `globproxy-my-data-${new Date().toISOString().slice(0, 10)}.json`)
      toast.success('Your data was downloaded')
    } catch (err: any) {
      toastApiError(err, 'Could not export your data')
    } finally {
      // finally: the early returns above used to skip this and leave the button on "Preparing…".
      setExporting(false)
    }
  }

  async function saveDefaultAuto(e?: React.FormEvent) {
    e?.preventDefault()
    if (defaultAuto.enabled) {
      if (!Number.isFinite(defaultAuto.threshold_gb) || defaultAuto.threshold_gb < 0) {
        toast.error('Threshold must be 0 or greater'); return
      }
      if (!Number.isFinite(defaultAuto.amount_gb) || defaultAuto.amount_gb <= 0) {
        toast.error('Top-up amount must be greater than 0'); return
      }
      if (defaultAuto.amount_gb <= defaultAuto.threshold_gb) {
        toast.error('The amount added must be larger than the threshold, or it would re-trigger immediately.'); return
      }
      if (!hasAtMostDecimals(defaultAuto.threshold_gb, 4) || !hasAtMostDecimals(defaultAuto.amount_gb, 4)) {
        toast.error('Use at most 4 decimal places.'); return
      }
    }
    setDefaultAutoLoading(true)
    try {
      // A half-edited (empty) number box is NaN in state; never put that on the wire
      // (JSON turns it into null) — when the feature is off the values are inert.
      await apiJson('PATCH', '/api/dashboard/settings/auto-topup-default', {
        ...defaultAuto,
        threshold_gb: Number.isFinite(defaultAuto.threshold_gb) ? defaultAuto.threshold_gb : 1,
        amount_gb: Number.isFinite(defaultAuto.amount_gb) ? defaultAuto.amount_gb : 5,
      })
      toast.success(defaultAuto.enabled ? 'Default auto-allocate saved' : 'Default auto-allocate turned off')
    } catch (err: any) {
      toastApiError(err, 'Failed to save default')
    }
    setDefaultAutoLoading(false)
  }

  // A signing secret is shown once. Creating or rotating a second one while
  // the first banner is still up replaced it — the first secret was lost for
  // good with no warning. Make the person dismiss it first.
  function secretPending(): boolean {
    if (!revealedSecret) return false
    toast.error('Copy your current signing secret and click \u201cDone\u201d first \u2014 it can\u2019t be shown again.')
    return true
  }

  async function createWebhook(e: React.FormEvent) {
    e.preventDefault()
    if (secretPending()) return
    if (newWebhookEvents.length === 0) { toast.error('Select at least one event'); return }
    setCreatingWebhook(true)
    try {
      const data = await apiJson('POST', '/api/dashboard/webhooks', { url: newWebhookUrl.trim(), event_types: newWebhookEvents, ...(newWebhookDesc.trim() ? { description: newWebhookDesc.trim() } : {}) })
      setRevealedSecret({ url: data.webhook.url, secret: data.webhook.secret })
      setWebhooks(w => [{ ...data.webhook, secret: undefined }, ...w])
      setNewWebhookUrl('')
      setNewWebhookDesc('')
    } catch (err: any) {
      toastApiError(err, 'Failed to add webhook')
    }
    setCreatingWebhook(false)
  }

  async function toggleWebhook(id: string, enabled: boolean) {
    try {
      const data = await apiJson('PATCH', `/api/dashboard/webhooks/${id}`, { enabled })
      setWebhooks(w => w.map(x => x.id === id ? { ...x, ...(data.webhook ?? { enabled }) } : x))
    } catch (err: any) {
      toastApiError(err, 'Failed to update webhook')
    }
  }

  function startEditWebhook(w: any) {
    setEditingWebhookId(w.id)
    setEditUrl(w.url)
    setEditDesc(w.description ?? '')
    setEditEvents([...(w.event_types ?? [])])
  }

  async function saveWebhookEdit(id: string) {
    if (editEvents.length === 0) { toast.error('Select at least one event'); return }
    setSavingWebhook(true)
    try {
      const data = await apiJson('PATCH', `/api/dashboard/webhooks/${id}`, { url: editUrl.trim(), event_types: editEvents, description: editDesc.trim() || null })
      setWebhooks(w => w.map(x => x.id === id ? { ...x, ...data.webhook } : x))
      setEditingWebhookId(null)
      toast.success('Webhook updated')
    } catch (err: any) {
      toastApiError(err, 'Failed to update webhook')
    }
    setSavingWebhook(false)
  }

  async function deleteWebhook(id: string) {
    if (!confirm('Delete this webhook? It will stop receiving events immediately.')) return
    try {
      await apiJson('DELETE', `/api/dashboard/webhooks/${id}`)
      toast.success('Webhook deleted')
      setWebhooks(w => w.filter(x => x.id !== id))
      if (logId === id) { setLogId(null); logIdRef.current = null; logReqRef.current++; setLogLoading(false) }
      if (editingWebhookId === id) setEditingWebhookId(null)
    } catch (err: any) {
      toastApiError(err, 'Failed to delete webhook')
    }
  }

  async function testWebhook(id: string) {
    setTestingId(id)
    try {
      await apiJson('POST', `/api/dashboard/webhooks/${id}/test`)
      toast.success('Test event delivered')
    } catch (err: any) {
      toastApiError(err, 'Test delivery failed — check the endpoint is reachable')
    }
    setTestingId(null)
  }

  function openRotateWebhook(id: string) {
    if (secretPending()) return
    setRotatingWebhookId(prev => prev === id ? null : id)
    setRotateGrace('1440')
  }

  // grace 1440 = the old secret keeps signing a second header for 24 h so the
  // receiver can be switched over without dropping events; 0 = it dies now
  // (the right choice if it leaked).
  async function rotateWebhookSecret(id: string) {
    if (secretPending() || rotatingSecret) return
    setRotatingSecret(true)
    try {
      const data = await apiJson('POST', `/api/dashboard/webhooks/${id}/rotate-secret`, { grace_minutes: Number(rotateGrace) })
      setRevealedSecret({ url: webhooks.find(w => w.id === id)?.url ?? 'webhook', secret: data.secret })
      setRotatingWebhookId(null)
    } catch (err: any) {
      toastApiError(err, 'Failed to rotate secret')
    } finally {
      setRotatingSecret(false)
    }
  }

  // The log shows one endpoint at a time and responses can arrive out of order, so every
  // load is tagged: a response is applied only if it is still the latest request AND its
  // endpoint is still the one open. logIdRef mirrors logId for use inside async handlers.
  const logIdRef = useRef<string | null>(null)
  const logReqRef = useRef(0)
  useEffect(() => { logIdRef.current = logId }, [logId])

  // cursor => append the next (older) page; otherwise replace the list. `depth` reloads at
  // least that many rows so a refresh after redeliver keeps older pages the user had loaded.
  async function loadDeliveries(id: string, cursor?: { before: string; id: string | null } | null, depth = 25) {
    const req = ++logReqRef.current
    setLogLoading(true)
    try {
      const limit = cursor ? 25 : Math.min(Math.max(depth, 25), 100)
      const data = await apiFetch(`/api/dashboard/webhooks/${id}/deliveries?limit=${limit}${cursor ? `&before=${encodeURIComponent(cursor.before)}${cursor.id ? `&before_id=${encodeURIComponent(cursor.id)}` : ''}` : ''}`)
      if (req !== logReqRef.current || logIdRef.current !== id) return
      setLogRows(prev => cursor ? [...prev, ...(data.deliveries ?? [])] : (data.deliveries ?? []))
      setLogNext(data.next_before ? { before: data.next_before, id: data.next_before_id ?? null } : null)
    } catch (err: any) {
      if (req !== logReqRef.current || logIdRef.current !== id) return
      // Keep what is already on screen (a failed "load more" must not wipe the loaded pages).
      if (!cursor) setLogRows([])
      toastApiError(err, 'Failed to load deliveries')
    }
    if (req === logReqRef.current) setLogLoading(false)
  }

  async function toggleLog(id: string) {
    if (logId === id) { setLogId(null); logIdRef.current = null; logReqRef.current++; setLogLoading(false); return }
    logIdRef.current = id
    detailReqRef.current++; setLogId(id); setDetailId(null); setDetail(null); setLogNext(null); setLogRows([])
    await loadDeliveries(id)
  }

  async function toggleDetail(endpointId: string, deliveryId: string) {
    const req = ++detailReqRef.current
    if (detailId === deliveryId) { setDetailId(null); setDetail(null); return }
    setDetailId(deliveryId); setDetail(null)
    try {
      const d = await apiFetch(`/api/dashboard/webhooks/${endpointId}/deliveries/${deliveryId}`)
      if (req === detailReqRef.current) setDetail(d)
    } catch (err: any) {
      if (req !== detailReqRef.current) return // a newer click owns the panel now
      toastApiError(err, 'Failed to load delivery')
      setDetailId(null)
    }
  }

  async function redeliver(endpointId: string, deliveryId: string) {
    try {
      await apiJson('POST', `/api/dashboard/webhooks/${endpointId}/deliveries/${deliveryId}/redeliver`)
      toast.success('Event redelivered')
    } catch (err: any) {
      toastApiError(err, 'Redelivery failed')
    }
    if (logIdRef.current === endpointId) await loadDeliveries(endpointId, null, logRows.length)
  }

  const [redeliveringAll, setRedeliveringAll] = useState(false)
  // Catch-up after an outage: re-sends the endpoint's failed deliveries, oldest first,
  // a few per click (the server stops early when the receiver is still down).
  async function redeliverAllFailed(endpointId: string) {
    setRedeliveringAll(true)
    try {
      const r = await apiJson('POST', `/api/dashboard/webhooks/${endpointId}/deliveries/redeliver-failed`, { limit: 5 })
      if (r.attempted === 0) toast.success('No failed deliveries to redeliver')
      else if (r.stopped_early) toast.error(`Sent ${r.succeeded} of ${r.attempted}, then stopped: your endpoint is still failing`)
      else toast.success(`Redelivered ${r.succeeded} of ${r.attempted}${r.more_failed ? ' — click again for the rest' : ''}`)
    } catch (err: any) {
      toastApiError(err, 'Redelivery failed')
    }
    setRedeliveringAll(false)
    if (logIdRef.current === endpointId) await loadDeliveries(endpointId, null, logRows.length)
  }

  async function submitApplication(e: React.FormEvent) {
    e.preventDefault()
    if (!appForm.full_name || !appForm.country || !appForm.phone || !appForm.monthly_volume) {
      toast.error('Please fill in all fields'); return
    }
    setApplying(true)
    try {
      await apiJson('POST', '/api/auth/apply-reseller', appForm)
      toast.success('Application submitted! We\'ll review and get back to you.')
      setProfile({ ...profile, reseller_status: 'pending' })
      setShowForm(false)
    } catch (err: any) {
      toastApiError(err, "Application failed")
    }
    setApplying(false)
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Settings</h1>
        <p className="text-muted text-sm mt-1">Manage your account details</p>
      </div>

      {profileError && (
        <div className="mb-5 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">{profileError}</div>
      )}

      {/* Profile */}
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-5">Profile</h2>
        <form onSubmit={saveProfile} className="flex flex-col gap-4">
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Email</label>
            <input value={profile?.email ?? ''} disabled
              className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm text-muted cursor-not-allowed" />
          </div>
          {([['Full name', 'full_name', 'Your name'], ['Company name', 'company_name', 'Your business name (optional)']] as const).map(([l, k, p]) => (
            <div key={k}>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">{l}</label>
              <input value={(form as any)[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} placeholder={p} maxLength={100}
                className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
            </div>
          ))}
          <button type="submit" disabled={loading || !profile}
            className="self-start bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
            {loading ? 'Saving...' : 'Save changes'}
          </button>
        </form>
      </div>

      {/* Change password — server-side: current password + 2FA step-up, revokes other sessions */}
      <ChangePasswordCard />

      {/* Change email — current password + 2FA step-up, double confirmation, notice to old address */}
      <ChangeEmailCard currentEmail={profile?.email} />

      {/* E-mail notifications — advisory e-mails only */}
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-3">E-mail notifications</h2>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={lowEmails} disabled={savingLowEmails || !profile}
            onChange={e => toggleLowEmails(e.target.checked)} className="mt-1" />
          <span>
            <span className="block text-sm text-ink">E-mail me when my bandwidth is running low</span>
            <span className="block text-xs text-muted mt-0.5">
              A heads-up when a session is running low (levels below), and when your account balance reaches 80% and 95%. We&apos;ll always e-mail you when a session runs out, and
              for security events and receipts. Webhooks are set up per endpoint and aren&apos;t affected by this.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 cursor-pointer mt-4 pt-4 border-t border-border">
          <input type="checkbox" checked={marketingEmails} disabled={savingMarketing || !profile}
            onChange={e => toggleMarketing(e.target.checked)} className="mt-1" />
          <span>
            <span className="block text-sm text-ink">Product news &amp; offers</span>
            <span className="block text-xs text-muted mt-0.5">
              Occasional e-mails about new features and special offers. Receipts, security notices and important notices about your account are always sent.
            </span>
          </span>
        </label>
        <div className="mt-4 pt-4 border-t border-border">
          <div className="text-sm text-ink mb-1">Session usage alerts</div>
          <p className="text-xs text-muted mb-3">
            Warn me when a session has used this much of its data. The first level is a heads-up, the second means it is about to stop. They also drive the banners on My Proxies and the session-low webhook.
          </p>
          <div className="flex items-end gap-3 flex-wrap">
            <label className="block">
              <span className="text-[10px] font-mono text-muted uppercase tracking-widest">Heads-up at (%)</span>
              <input value={warnPct} onChange={e => setWarnPct(e.target.value)} inputMode="numeric" disabled={savingPcts || !profile}
                className="mt-1.5 block w-24 border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
            </label>
            <label className="block">
              <span className="text-[10px] font-mono text-muted uppercase tracking-widest">Urgent at (%)</span>
              <input value={urgentPct} onChange={e => setUrgentPct(e.target.value)} inputMode="numeric" disabled={savingPcts || !profile}
                className="mt-1.5 block w-24 border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
            </label>
            <button onClick={saveAlertLevels} disabled={savingPcts || !profile}
              className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium disabled:opacity-60">
              {savingPcts ? 'Saving…' : 'Save levels'}
            </button>
          </div>
        </div>
      </div>

      {/* Default auto-allocate */}
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-display font-bold text-base text-ink">Default auto-allocate</h2>
          <button
            type="button"
            onClick={() => {
              const next = !defaultAuto.enabled
              setDefaultAuto(d => ({ ...d, enabled: next }))
              // Turning it OFF takes effect at once (nothing to validate); turning it ON waits for the numbers + Save.
              if (!next) {
                apiJson('PATCH', '/api/dashboard/settings/auto-topup-default', { enabled: false,
                  threshold_gb: Number.isFinite(defaultAuto.threshold_gb) ? defaultAuto.threshold_gb : 1,
                  amount_gb: Number.isFinite(defaultAuto.amount_gb) ? defaultAuto.amount_gb : 5 })
                  .then(() => toast.success('Default auto-allocate turned off'))
                  .catch((err: any) => { setDefaultAuto(d => ({ ...d, enabled: true })); toastApiError(err, 'Failed to save default') })
              }
            }}
            aria-pressed={defaultAuto.enabled}
            className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${defaultAuto.enabled ? 'bg-accent' : 'bg-border'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${defaultAuto.enabled ? 'translate-x-4' : ''}`} />
          </button>
        </div>
        <p className="text-xs text-muted mb-4">
          Pre-fills the auto-allocate section on new proxy sessions with these numbers. Each session's own settings can still be changed
          before it's created, or afterward from its Bandwidth tab — this only saves you re-typing the same values every time.
        </p>
        {defaultAuto.enabled && (
          <form onSubmit={saveDefaultAuto} className="flex flex-wrap items-end gap-3 mb-1">
            <div>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">When remaining falls below</label>
              <div className="relative">
                <NumberField min={0} value={defaultAuto.threshold_gb} ariaLabel="Threshold in GB"
                  onValue={n => setDefaultAuto(d => ({ ...d, threshold_gb: n }))}
                  className="w-32 bg-surface border border-border px-3.5 py-2.5 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors pr-9" />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-mono text-muted pointer-events-none">GB</span>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Add</label>
              <div className="relative">
                <NumberField min={0.01} value={defaultAuto.amount_gb} ariaLabel="Top-up amount in GB"
                  onValue={n => setDefaultAuto(d => ({ ...d, amount_gb: n }))}
                  className="w-32 bg-surface border border-border px-3.5 py-2.5 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors pr-9" />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-mono text-muted pointer-events-none">GB</span>
              </div>
            </div>
            <button type="submit" disabled={defaultAutoLoading}
              className="border border-border text-ink2 px-5 py-2.5 rounded-xl text-sm font-medium hover:border-ink2 hover:text-ink disabled:opacity-60 transition-all">
              {defaultAutoLoading ? 'Saving...' : 'Save default'}
            </button>
          </form>
        )}
        {defaultAuto.enabled && <p className="text-[11px] text-muted mt-2">Not saved until you press “Save default”.</p>}
      </div>

      {/* Webhooks */}
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-2">Webhooks</h2>
        <p className="text-xs text-muted mb-4">
          Get an HTTP POST when sessions change or your bandwidth runs low. Each request is signed with your endpoint's
          secret (<span className="font-mono">X-GlobProxy-Signature-V2</span> carries a timestamp for replay protection;
          <span className="font-mono"> X-GlobProxy-Signature</span> is the plain HMAC-SHA256 of the body). Failed deliveries are retried
          for up to ~9 hours, and an endpoint that keeps failing is disabled automatically. See the{' '}
          <a href="/docs/api#webhooks" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">webhook docs</a>.
        </p>

        {revealedSecret && (
          <div className="bg-accent-light border border-accent/30 rounded-xl p-5 mb-5">
            <h3 className="font-display font-bold text-sm text-ink mb-1.5">Your signing secret</h3>
            <p className="text-[11px] font-mono text-muted mb-2 truncate">for {revealedSecret.url}</p>
            <p className="text-xs text-muted mb-3">
              Copy this now — we only show it once and can't display it again after you leave this page. If you lose it, use
              “Rotate secret” on the webhook to generate a new one.
            </p>
            <div className="bg-white border border-border rounded-lg p-3 flex items-center gap-3">
              <span className="font-mono text-xs text-ink flex-1 truncate select-all">{revealedSecret.secret}</span>
              <button onClick={async () => { (await copyText(revealedSecret.secret)) ? toast.success('Secret copied') : toast.error('Couldn\u2019t access the clipboard — select the secret and copy it manually.') }}
                className="text-xs font-mono text-accent border border-accent/30 px-2.5 py-1 rounded-lg transition-colors flex-shrink-0">
                Copy
              </button>
            </div>
            <button onClick={() => setRevealedSecret(null)} className="text-xs text-muted hover:text-ink mt-3">
              Done, I've saved it
            </button>
          </div>
        )}

        {webhooksLoading ? (
          <p className="text-sm text-muted mb-4">Loading...</p>
        ) : webhooksError ? (
          <p className="text-sm text-red-500 mb-4">{webhooksError}{' '}
            <button onClick={loadWebhooks} className="underline hover:opacity-70">Retry</button>
          </p>
        ) : webhooks.length === 0 ? (
          <p className="text-sm text-muted mb-4">No webhooks yet.</p>
        ) : (
          <div className="flex flex-col gap-2 mb-5">
            {webhooks.map(w => (
              <div key={w.id} className={`border border-border rounded-lg p-3 ${w.enabled ? '' : 'opacity-50'}`}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-sm text-ink font-mono truncate max-w-full">{w.url}</div>
                    {w.description ? <div className="text-xs text-ink2 mt-0.5 truncate max-w-full">{w.description}</div> : null}
                    <div className="text-xs text-muted mt-0.5">
                      {w.event_types.includes(WEBHOOK_WILDCARD) ? 'all events' : w.event_types.join(', ')}
                      {w.previous_secret_expires_at && new Date(w.previous_secret_expires_at) > new Date()
                        ? <span className="text-amber-600"> · old signing secret also accepted until {new Date(w.previous_secret_expires_at).toLocaleString()}</span> : null}
                      {!w.enabled && w.disabled_reason ? <span className="text-red-500"> · disabled: {w.disabled_reason}</span> : null}
                      {w.last_failure_at && (!w.last_success_at || new Date(w.last_failure_at) > new Date(w.last_success_at))
                        ? <span className="text-red-500"> · last delivery failed{w.last_error ? ` (${w.last_error})` : ''}</span>
                        : w.last_success_at ? <span className="text-green-600"> · delivering OK</span> : ' · no deliveries yet'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={() => testWebhook(w.id)} disabled={testingId === w.id}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50">
                      {testingId === w.id ? 'Sending...' : 'Send test'}
                    </button>
                    <button onClick={() => (editingWebhookId === w.id ? setEditingWebhookId(null) : startEditWebhook(w))}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                      {editingWebhookId === w.id ? 'Cancel' : 'Edit'}
                    </button>
                    <button onClick={() => toggleLog(w.id)}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                      {logId === w.id ? 'Hide log' : 'Log'}
                    </button>
                    <button onClick={() => openRotateWebhook(w.id)}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                      Rotate secret
                    </button>
                    <button onClick={() => toggleWebhook(w.id, !w.enabled)}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                      {w.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => deleteWebhook(w.id)}
                      className="text-xs font-mono text-muted hover:text-red-500 border border-border hover:border-red-200 px-2.5 py-1 rounded-lg transition-colors">
                      Delete
                    </button>
                  </div>
                </div>
                {rotatingWebhookId === w.id && (
                  <div className="mt-3 border-t border-border pt-3 flex flex-col gap-2">
                    <label className="flex items-start gap-2 text-xs text-ink cursor-pointer">
                      <input type="radio" name={`wh-grace-${w.id}`} checked={rotateGrace === '1440'} onChange={() => setRotateGrace('1440')} className="mt-0.5" />
                      <span>Keep the old secret working for 24 hours <span className="text-muted">— events carry an extra X-GlobProxy-Signature-V2-Previous header while you switch your receiver over.</span></span>
                    </label>
                    <label className="flex items-start gap-2 text-xs text-ink cursor-pointer">
                      <input type="radio" name={`wh-grace-${w.id}`} checked={rotateGrace === '0'} onChange={() => setRotateGrace('0')} className="mt-0.5" />
                      <span>Revoke the old secret now <span className="text-muted">— choose this if it leaked. Events signed with it stop verifying immediately.</span></span>
                    </label>
                    <div className="flex gap-2">
                      <button onClick={() => rotateWebhookSecret(w.id)} disabled={rotatingSecret}
                        className="text-xs bg-accent text-white px-3 py-1.5 rounded-lg disabled:opacity-60">
                        {rotatingSecret ? 'Rotating…' : 'Rotate secret'}
                      </button>
                      <button onClick={() => setRotatingWebhookId(null)} className="text-xs text-muted hover:text-ink px-2">Cancel</button>
                    </div>
                  </div>
                )}
                {editingWebhookId === w.id && (
                  <div className="mt-3 border-t border-border pt-3">
                    <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Endpoint URL</label>
                    <input type="url" value={editUrl} onChange={e => setEditUrl(e.target.value)}
                      className="w-full bg-surface border border-border px-3 py-2 rounded-lg text-sm font-mono focus:outline-none focus:border-accent transition-colors mb-3" />
                    <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Description (optional)</label>
                    <input type="text" maxLength={200} value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="e.g. production billing listener"
                      className="w-full bg-surface border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent transition-colors mb-3" />
                    <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                      <input type="checkbox" checked={editEvents.includes(WEBHOOK_WILDCARD)}
                        onChange={e => setEditEvents(e.target.checked ? [WEBHOOK_WILDCARD] : [])}
                        className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-accent" />
                      <span className="text-xs text-ink font-medium">All events, including ones we add later</span>
                    </label>
                    <div className={`flex flex-wrap gap-4 mb-3 ${editEvents.includes(WEBHOOK_WILDCARD) ? 'opacity-40 pointer-events-none' : ''}`}>
                      {WEBHOOK_EVENTS.map(val => (
                        <label key={val} className="flex items-center gap-2 cursor-pointer select-none">
                          <input type="checkbox" checked={editEvents.includes(WEBHOOK_WILDCARD) || editEvents.includes(val)}
                            onChange={e => setEditEvents(evs => e.target.checked ? [...evs, val] : evs.filter(x => x !== val))}
                            className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-accent" />
                          <span className="text-xs text-ink2">{WEBHOOK_EVENT_LABELS[val]}</span>
                        </label>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted mb-3">The signing secret stays the same when you change the URL.</p>
                    <button onClick={() => saveWebhookEdit(w.id)} disabled={savingWebhook || !editUrl.trim()}
                      className="bg-accent text-white px-4 py-2 rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-60">
                      {savingWebhook ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                )}
                {logId === w.id && (
                  <div className="mt-3 border-t border-border pt-3">
                    {logLoading ? (
                      <p className="text-xs text-muted">Loading...</p>
                    ) : logRows.length === 0 ? (
                      <p className="text-xs text-muted">No deliveries in the last 14 days.</p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {logRows.some(d => d.status === 'failed' && d.event_type !== 'test') && (
                          <button onClick={() => redeliverAllFailed(w.id)} disabled={redeliveringAll}
                            className="text-xs text-ink2 hover:text-ink border border-border px-2.5 py-1 rounded-lg self-start mb-1 disabled:opacity-60">
                            {redeliveringAll ? 'Redelivering…' : 'Redeliver all failed'}
                          </button>
                        )}
                        {logRows.map(d => (
                          <div key={d.id}>
                          <div className="flex items-center justify-between gap-3 text-xs font-mono">
                            <div className="min-w-0 truncate">
                              <span className={d.status === 'succeeded' ? 'text-green-600' : d.status === 'retrying' ? 'text-amber-600' : 'text-red-500'}>
                                {d.status}
                              </span>
                              <span className="text-ink2"> · {d.event_type}</span>
                              <span className="text-muted"> · {new Date(d.created_at).toLocaleString()}</span>
                              <span className="text-muted"> · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}</span>
                              {d.response_status ? <span className="text-muted"> · HTTP {d.response_status}</span> : null}
                              {d.last_error && d.status !== 'succeeded' ? <span className="text-red-500"> · {d.last_error}</span> : null}
                            </div>
                            <div className="flex gap-1.5 flex-shrink-0">
                              <button onClick={() => toggleDetail(w.id, d.id)}
                                className="text-muted hover:text-ink border border-border px-2 py-0.5 rounded-lg">
                                Details
                              </button>
                              {d.event_type !== 'test' && (
                                <button onClick={() => redeliver(w.id, d.id)}
                                  className="text-muted hover:text-ink border border-border px-2 py-0.5 rounded-lg">
                                  Redeliver
                                </button>
                              )}
                            </div>
                          </div>
                          {detailId === d.id && (
                            <div className="mt-1.5 mb-2 bg-surface border border-border rounded-lg p-3 text-[11px] font-mono text-ink2">
                              {detail === null ? 'Loading…' : (
                                <>
                                  <div className="text-muted mb-1">Event body that was sent</div>
                                  <pre className="whitespace-pre-wrap break-all max-h-48 overflow-auto">{JSON.stringify(detail.payload, null, 2)}</pre>
                                  <div className="text-muted mt-2 mb-1">Your endpoint&apos;s response{detail.response_status ? ` (HTTP ${detail.response_status})` : ''}</div>
                                  <pre className="whitespace-pre-wrap break-all max-h-32 overflow-auto">{detail.response_body || '(empty or not captured)'}</pre>
                                </>
                              )}
                            </div>
                          )}
                          </div>
                        ))}
                        {logNext && (
                          <button onClick={() => loadDeliveries(w.id, logNext)}
                            className="text-xs text-muted hover:text-ink underline self-start mt-1">
                            Load older deliveries
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <form onSubmit={createWebhook} className="border-t border-border pt-4">
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Endpoint URL</label>
          <input type="url" placeholder="https://your-server.com/webhooks/globproxy" value={newWebhookUrl}
            onChange={e => setNewWebhookUrl(e.target.value)}
            className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm font-mono focus:outline-none focus:border-accent transition-colors mb-3" />
          <input type="text" maxLength={200} placeholder="Description (optional) — e.g. production billing listener" value={newWebhookDesc}
            onChange={e => setNewWebhookDesc(e.target.value)}
            className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors mb-3" />
          <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
            <input type="checkbox" checked={newWebhookEvents.includes(WEBHOOK_WILDCARD)}
              onChange={e => setNewWebhookEvents(e.target.checked ? [WEBHOOK_WILDCARD] : [])}
              className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-accent" />
            <span className="text-xs text-ink font-medium">All events, including ones we add later</span>
          </label>
          <div className={`flex flex-wrap gap-4 mb-4 ${newWebhookEvents.includes(WEBHOOK_WILDCARD) ? 'opacity-40 pointer-events-none' : ''}`}>
            {WEBHOOK_EVENTS.map((val) => [val, WEBHOOK_EVENT_LABELS[val]] as const).map(([val, label]) => (
              <label key={val} className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={newWebhookEvents.includes(WEBHOOK_WILDCARD) || newWebhookEvents.includes(val)}
                  onChange={e => setNewWebhookEvents(evs => e.target.checked ? [...evs, val] : evs.filter(x => x !== val))}
                  className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-accent" />
                <span className="text-xs text-ink2">{label}</span>
              </label>
            ))}
          </div>
          <button type="submit" disabled={creatingWebhook || !newWebhookUrl.trim()}
            className="border border-border text-ink2 px-6 py-2.5 rounded-xl text-sm font-medium hover:border-ink2 hover:text-ink disabled:opacity-60 transition-all">
            {creatingWebhook ? 'Adding...' : 'Add webhook'}
          </button>
        </form>
      </div>

      {profile && <TwoFactorSettings role={profile.role ?? 'user'} />}

      <ActiveSessionsCard />

      <SecurityActivityCard />

      {/* Reseller application */}
      {profile?.role === 'user' && profile?.reseller_status !== 'pending' && (
        <div className="bg-accent2-light border border-accent2/20 rounded-xl p-6">
          <h2 className="font-display font-bold text-base text-accent2 mb-2">Become a reseller</h2>
          {profile?.reseller_status === 'rejected' && (
            <p className="text-xs text-ink2 bg-white/60 border border-accent2/20 rounded-lg px-3 py-2 mb-3">
              Your previous application wasn&apos;t approved. You&apos;re welcome to apply again with more detail about how you plan to resell.
            </p>
          )}
          <p className="text-sm text-ink2 font-light mb-4">
            Buy wholesale bandwidth and resell under your own brand. No minimum commitment.
          </p>

          {!showForm ? (
            <button onClick={() => setShowForm(true)}
              className="inline-flex items-center gap-2 bg-accent2 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">
              Apply now →
            </button>
          ) : (
            <form onSubmit={submitApplication} className="flex flex-col gap-4 mt-2">
              {/* Name */}
              <div>
                <label className="block text-[10px] font-mono text-accent2/70 uppercase tracking-wider mb-1.5">Full name *</label>
                <input
                  type="text"
                  value={appForm.full_name}
                  onChange={e => setAppForm({ ...appForm, full_name: e.target.value })}
                  placeholder="Your full name"
                  required
                  className="w-full bg-white border border-accent2/20 px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent2 transition-colors"
                />
              </div>

              {/* Country */}
              <div>
                <label className="block text-[10px] font-mono text-accent2/70 uppercase tracking-wider mb-1.5">Country *</label>
                {countryLoadFailed ? (
                  <input
                    type="text"
                    value={appForm.country}
                    onChange={e => setAppForm({ ...appForm, country: e.target.value })}
                    placeholder="Your country"
                    maxLength={80}
                    required
                    className="w-full bg-white border border-accent2/20 px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent2 transition-colors"
                  />
                ) : (
                  <select
                    value={appForm.country}
                    onChange={e => setAppForm({ ...appForm, country: e.target.value })}
                    required
                    className="w-full bg-white border border-accent2/20 px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent2 transition-colors"
                  >
                    <option value="">{countryNames ? 'Select your country' : 'Loading countries…'}</option>
                    {(countryNames ?? []).map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
              </div>

              {/* Phone */}
              <div>
                <label className="block text-[10px] font-mono text-accent2/70 uppercase tracking-wider mb-1.5">Phone / WhatsApp *</label>
                <input
                  type="tel"
                  value={appForm.phone}
                  onChange={e => setAppForm({ ...appForm, phone: e.target.value })}
                  placeholder="+1 555 000 0000"
                  required
                  className="w-full bg-white border border-accent2/20 px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent2 transition-colors"
                />
              </div>

              {/* Monthly volume */}
              <div>
                <label className="block text-[10px] font-mono text-accent2/70 uppercase tracking-wider mb-1.5">Expected monthly volume *</label>
                <select
                  value={appForm.monthly_volume}
                  onChange={e => setAppForm({ ...appForm, monthly_volume: e.target.value })}
                  required
                  className="w-full bg-white border border-accent2/20 px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent2 transition-colors"
                >
                  <option value="">Select expected volume</option>
                  {VOLUME_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>

              <div className="flex gap-3 mt-1">
                <button type="submit" disabled={applying}
                  className="bg-accent2 text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
                  {applying ? 'Submitting...' : 'Submit application →'}
                </button>
                <button type="button" onClick={() => setShowForm(false)}
                  className="border border-accent2/20 text-accent2 px-5 py-2.5 rounded-xl text-sm hover:bg-white transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {profile?.reseller_status === 'pending' && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6">
          <h2 className="font-display font-bold text-base text-yellow-800 mb-2">Application under review</h2>
          <p className="text-sm text-yellow-700 font-light">
            We've received your application and will be in touch shortly.
          </p>
        </div>
      )}

      {/* Danger zone — was previously implemented server-side
          (app/api/user/delete-account) with no button anywhere to reach
          it. Kept visually separate (border color, position at the very
          end) from every reversible action above it. */}
      <div id="delete-account" className="bg-white border border-red-200 rounded-xl p-6 mt-5">
        <h2 className="font-display font-bold text-base text-red-600 mb-2">Danger zone</h2>
        <p className="text-sm text-ink2 font-light mb-4">
          Permanently delete your account. Deletion is scheduled for 7 days after you ask, so you can change your mind;
          then your proxy credentials stop working and your personal data is anonymised. That cannot be undone.
        </p>
        <p className="text-sm text-ink2 font-light mb-4">
          Want a copy first?{' '}
          <button type="button" onClick={downloadMyData} disabled={exporting}
            className="text-accent underline underline-offset-2 disabled:opacity-50">
            {exporting ? 'Preparing…' : 'Download my data (JSON)'}
          </button>
        </p>
        {deletionScheduledAt ? (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <p className="text-sm text-amber-800 font-medium mb-1">
              Your account is scheduled to be deleted on {new Date(deletionScheduledAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.
            </p>
            <p className="text-sm text-amber-800 mb-3">Until then nothing changes. Cancel any time before then to keep your account.</p>
            <button onClick={cancelDeletion} disabled={cancellingDeletion}
              className="bg-white border border-amber-300 text-amber-900 px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-amber-100 disabled:opacity-50 transition-all">
              {cancellingDeletion ? 'Cancelling…' : 'Cancel deletion'}
            </button>
          </div>
        ) : !showDelete ? (
          <button onClick={() => setShowDelete(true)}
            className="border border-red-200 text-red-500 px-6 py-2.5 rounded-xl text-sm font-medium hover:bg-red-50 transition-all">
            Delete my account…
          </button>
        ) : (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-sm text-red-700 font-medium mb-2">This will permanently:</p>
            <ul className="text-sm text-red-700 list-disc pl-5 mb-3 space-y-1">
              <li>
                Delete {deleteFacts ? `${deleteFacts.sessions} proxy session${deleteFacts.sessions === 1 ? '' : 's'}` : 'all your proxy sessions'} — they stop working once the account is deleted.
              </li>
              <li>
                Forfeit {deleteFacts ? <strong>{formatGb(deleteFacts.remainingGb)} GB</strong> : 'any'} of unused bandwidth. It is not refunded or transferable.
              </li>
              {deleteFacts && deleteFacts.unpaidEarningsUsd > 0 && (
                <li>Forfeit <strong>${deleteFacts.unpaidEarningsUsd.toFixed(2)}</strong> of affiliate earnings that have not been paid out yet, and cancel any payout still waiting to be sent.</li>
              )}
              <li>Remove your name, email, payout details, webhooks and revoke your API keys.</li>
              <li>Keep only what accounting requires: records of past payments and invoices.</li>
            </ul>
            <label className="block text-xs text-red-700 mb-1.5">Type <span className="font-mono font-bold">DELETE</span> to confirm</label>
            <input value={deleteText} onChange={e => setDeleteText(e.target.value)} autoComplete="off"
              className="w-full max-w-xs bg-white border border-red-200 px-3 py-2 rounded-lg text-sm font-mono focus:outline-none focus:border-red-400 mb-3" />
            <div className="flex gap-3">
              <button onClick={deleteAccount} disabled={deleting || deleteText.trim().toUpperCase() !== 'DELETE'}
                className="bg-red-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-40 transition-all">
                {deleting ? 'Working…' : 'Schedule deletion in 7 days'}
              </button>
              <button onClick={() => { setShowDelete(false); setDeleteText('') }} disabled={deleting}
                className="border border-border text-ink2 px-5 py-2.5 rounded-xl text-sm hover:text-ink">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="max-w-2xl text-sm text-muted">Loading...</div>}>
      <SettingsPageInner />
    </Suspense>
  )
}
