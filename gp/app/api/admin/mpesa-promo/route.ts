import { authorizeAdmin, readJson, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import {
  PROMO_KEY, MAX_PROMO_PCT, parsePromo, serializePromo, promoState, extendedEnd, endProblem, validPercent, cleanLabel,
  type MpesaPromo,
} from '@/lib/promo'
import { NextResponse } from 'next/server'

// Admin control of the M-Pesa offer (lib/promo.ts): create or edit it, extend it, end it now, or
// remove it. One JSON value in platform_settings, so every change is one atomic write.
//
//   { percent, endsAt, startsAt?, label?, enabled? }   create / replace the offer
//   { extendHours: 1..720 }                             push the end later (from now, if it already ended)
//   { endNow: true }                                    end it immediately (the record stays, for the page to show "ended")
//   { enabled: false|true }                             pause / resume without touching the dates
//   { remove: true }                                    delete it entirely
//
// A change to an existing offer only applies if nobody else changed it since this admin loaded the
// page (compare-and-swap on the stored value), so two admins cannot silently overwrite each other —
// e.g. one extending the offer while the other ends it.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{
    percent?: unknown; endsAt?: unknown; startsAt?: unknown; label?: unknown; enabled?: unknown
    extendHours?: unknown; endNow?: unknown; remove?: unknown
    version?: unknown // the offer's updated_at as this admin's page loaded it (null = no offer then)
  }>(req)
  if (!body) return badRequest('Invalid request')

  const { data: row, error: readErr } = await supabase.from('platform_settings').select('value, updated_at').eq('key', PROMO_KEY).maybeSingle()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  const prevRaw: string | null = row?.value ?? null
  // A stale page (someone else extended, ended or removed the offer since it loaded) must not act
  // on what it remembers: "extend by a day" on a page that still shows the old end time would
  // otherwise quietly undo the other admin's change.
  if (body.version !== undefined) {
    const loaded = body.version === null ? null : typeof body.version === 'string' ? Date.parse(body.version) : NaN
    const current = row?.updated_at ? Date.parse(row.updated_at) : null
    if (loaded !== current) return NextResponse.json({ error: 'The offer was changed since this page loaded — reload and try again.' }, { status: 409 })
  }
  const prev = parsePromo(prevRaw)
  const now = Date.now()

  async function write(next: MpesaPromo | null, action: string, details: Record<string, unknown>) {
    const nowIso = new Date().toISOString()
    if (next === null) {
      if (prevRaw === null) return NextResponse.json({ success: true, promo: null })
      const { data, error } = await supabase.from('platform_settings').delete().eq('key', PROMO_KEY).eq('value', prevRaw).select('key')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!data?.length) return NextResponse.json({ error: 'The offer was changed by someone else — reload the page and try again.' }, { status: 409 })
    } else {
      const value = serializePromo(next)
      if (prevRaw === null) {
        // Create. A concurrent create loses on the primary key instead of overwriting.
        const { error } = await supabase.from('platform_settings').insert({ key: PROMO_KEY, value, updated_at: nowIso })
        if (error) {
          const dup = (error as any).code === '23505'
          return NextResponse.json({ error: dup ? 'The offer was created by someone else — reload the page.' : error.message }, { status: dup ? 409 : 500 })
        }
      } else {
        const { data, error } = await supabase.from('platform_settings')
          .update({ value, updated_at: nowIso }).eq('key', PROMO_KEY).eq('value', prevRaw).select('key')
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        if (!data?.length) return NextResponse.json({ error: 'The offer was changed by someone else — reload the page and try again.' }, { status: 409 })
      }
    }
    await logAdminAction(supabase, {
      adminId, action,
      details: { ...details, before: prev ? { percent: prev.percent, endsAt: prev.endsAt, startsAt: prev.startsAt, enabled: prev.enabled } : null },
    })
    return NextResponse.json({ success: true, promo: next, state: promoState(next, Date.now()) })
  }

  if (body.remove === true) return write(null, 'mpesa.promo.remove', {})

  if (body.endNow === true) {
    if (!prev) return badRequest('There is no offer to end')
    return write({ ...prev, endsAt: new Date(now).toISOString() }, 'mpesa.promo.end', { endsAt: new Date(now).toISOString() })
  }

  if (body.extendHours !== undefined) {
    const h = body.extendHours
    if (typeof h !== 'number' || !Number.isFinite(h) || h < 1 || h > 720 || !Number.isInteger(h)) return badRequest('Extend by a whole number of hours between 1 and 720')
    if (!prev) return badRequest('There is no offer to extend — create one first')
    const endsAt = extendedEnd(prev, h, now)
    const problem = endProblem(endsAt, prev.startsAt, now)
    if (problem) return badRequest(problem)
    // Extending an offer that had ended (or been paused) is a deliberate "run it again": turn it back on.
    return write({ ...prev, enabled: true, endsAt }, 'mpesa.promo.extend', { hours: h, endsAt })
  }

  // Pause / resume only.
  const onlyEnabled = body.enabled !== undefined && body.percent === undefined && body.endsAt === undefined
    && body.startsAt === undefined && body.label === undefined
  if (onlyEnabled) {
    if (typeof body.enabled !== 'boolean') return badRequest('enabled must be true or false')
    if (!prev) return badRequest('There is no offer yet — create one first')
    return write({ ...prev, enabled: body.enabled }, body.enabled ? 'mpesa.promo.resume' : 'mpesa.promo.pause', { enabled: body.enabled })
  }

  // Create / replace: every field is validated; a blank or malformed one never silently becomes a default.
  if (!validPercent(body.percent)) return badRequest(`The discount must be a number above 0 and at most ${MAX_PROMO_PCT} (up to 2 decimals)`)
  if (typeof body.endsAt !== 'string' || Number.isNaN(Date.parse(body.endsAt))) return badRequest('Set a valid end time')
  const endsAt = new Date(body.endsAt).toISOString()
  let startsAt: string | null = null
  if (body.startsAt !== undefined && body.startsAt !== null && body.startsAt !== '') {
    if (typeof body.startsAt !== 'string' || Number.isNaN(Date.parse(body.startsAt))) return badRequest('The start time is not a valid date')
    startsAt = new Date(body.startsAt).toISOString()
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return badRequest('enabled must be true or false')
  const problem = endProblem(endsAt, startsAt, now)
  if (problem) return badRequest(problem)
  const label = body.label === undefined ? (prev?.label ?? '') : cleanLabel(body.label)
  const next: MpesaPromo = { enabled: body.enabled ?? true, percent: body.percent, startsAt, endsAt, label }
  return write(next, prev ? 'mpesa.promo.edit' : 'mpesa.promo.create', { percent: next.percent, endsAt, startsAt, label, enabled: next.enabled })
}
