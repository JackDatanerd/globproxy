// Small browser-side helpers shared by the dashboard components.
//
// apiFetch: every dashboard call used to do `await res.json()` and then
// `throw new Error(data.error)`. That blows up with "Unexpected token <" on a
// non-JSON 5xx, shows "undefined" when the body has no `error`, and had no
// answer at all for the 403 `mfa_required` response the step-up gate sends —
// the user just saw a red toast with no way forward. This normalises all
// three.

import toast from 'react-hot-toast'
import { fetchWithReauth } from '@/lib/reauthPrompt'

export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

// Shared by every call that doesn't go through apiFetch: the step-up gate's
// 403 must send the customer to verify, not leave them on a raw error.
export function redirectToMfa(data: any): void {
  const next = encodeURIComponent(window.location.pathname + window.location.search)
  window.location.href = `${data?.redirect || '/auth/mfa-verify'}?next=${next}`
}

// Shows an API failure as a toast — except the 2FA step-up, where the page is
// already redirecting to verification and a red toast would only flash.
export function toastApiError(err: any, fallback = 'Something went wrong'): void {
  if (err?.code === 'mfa_required' || err?.code === 'reauth_required') return
  toast.error(err?.message || fallback)
}

export async function apiFetch<T = any>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    // Accounts without 2FA get a one-time "confirm your password" dialog on
    // sensitive actions (403 reauth_required) and the request is retried.
    res = await fetchWithReauth(url, init)
  } catch {
    throw new ApiError('Network error — check your connection and try again.', 0)
  }
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 403 && data?.code === 'mfa_required') {
      redirectToMfa(data)
      throw new ApiError('Two-factor verification required — redirecting…', 403, 'mfa_required')
    }
    if (res.status === 403 && data?.code === 'reauth_required') {
      throw new ApiError('Confirmation is required for this action.', 403, 'reauth_required')
    }
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.code)
  }
  return data as T
}

export function apiJson<T = any>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// navigator.clipboard is undefined on non-secure origins and rejects when the
// document isn't focused or permission is denied — and the old callers fired
// it unawaited and toasted "Copied" regardless. Returns whether it worked.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// Downloads a server-generated file (CSV export). A plain <a href> navigation
// to these step-up-gated routes turned an expired 2FA session into a raw JSON
// error page; fetching them lets the 403 redirect to verification and any
// other failure show as a toast on the page the customer is already on.
export async function downloadFile(url: string, fallbackName: string): Promise<void> {
  let res: Response
  try {
    res = await fetchWithReauth(url)
  } catch {
    throw new ApiError('Network error — check your connection and try again.', 0)
  }
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}))
    if (res.status === 403 && data?.code === 'mfa_required') {
      redirectToMfa(data)
      throw new ApiError('Two-factor verification required — redirecting…', 403, 'mfa_required')
    }
    throw new ApiError(data?.error || `Export failed (${res.status})`, res.status, data?.code)
  }
  const cd = res.headers.get('content-disposition') || ''
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  const name = m ? decodeURIComponent(m[1]) : fallbackName
  saveBlob(await res.blob(), name)
}

/**
 * Saves a Blob as a file download. The anchor is attached while it is clicked
 * (a detached anchor's click is ignored by some browsers) and the object URL is
 * revoked later — revoking in the same tick cancels the download in Firefox and
 * Safari. Use this for EVERY client-side download.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

export function saveTextFile(text: string, filename: string, mime = 'text/plain'): void {
  saveBlob(new Blob([text], { type: mime }), filename)
}
