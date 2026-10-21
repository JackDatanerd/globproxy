// Browser side of lib/reauth.ts ("sudo mode"). Sensitive routes answer
// 403 { code: 'reauth_required' } when the account has no 2FA and the password
// hasn't been confirmed recently. fetchWithReauth() shows a small "Confirm your
// password" dialog, posts it to /api/auth/reauth, and then retries the original
// request once — so callers just see the request succeed (or the user decline).
//
// Built with plain DOM (no React tree needed) so any client code, including
// pages that call fetch() directly, can use it.

let pending: Promise<boolean> | null = null

// 'password' for accounts without 2FA; 'totp' for accounts with it, which must
// enter a FRESH authenticator (or backup) code instead — see lib/reauth.ts.
export type ReauthMethod = 'password' | 'totp'

export function promptForPassword(method: ReauthMethod = 'password'): Promise<boolean> {
  if (pending) return pending
  const totp = method === 'totp'
  pending = new Promise<boolean>(resolve => {
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', totp ? 'Confirm with your authenticator' : 'Confirm your password')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif;'
    overlay.innerHTML = `
      <form style="background:#111827;color:#f9fafb;border:1px solid #374151;border-radius:12px;padding:24px;width:100%;max-width:380px;box-shadow:0 20px 50px rgba(0,0,0,.5);">
        <h2 style="margin:0 0 6px;font-size:18px;font-weight:700;">${totp ? 'Enter a fresh code' : 'Confirm your password'}</h2>
        <p style="margin:0 0 16px;font-size:13px;color:#9ca3af;">${totp ? 'This action is sensitive. Enter the current 6-digit code from your authenticator app (or a backup code).' : 'This action is sensitive. Enter your account password to continue.'}</p>
        <input type="${totp ? 'text' : 'password'}" ${totp ? 'inputmode="text" autocomplete="one-time-code"' : 'autocomplete="current-password"'} required placeholder="${totp ? 'Code' : 'Password'}"
          style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #4b5563;background:#1f2937;color:#f9fafb;font-size:14px;outline:none;" />
        <p data-err style="margin:8px 0 0;font-size:12px;color:#f87171;min-height:16px;"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
          <button type="button" data-cancel style="padding:8px 14px;border-radius:8px;border:1px solid #4b5563;background:transparent;color:#d1d5db;font-size:14px;cursor:pointer;">Cancel</button>
          <button type="submit" style="padding:8px 14px;border-radius:8px;border:0;background:#2563eb;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">Confirm</button>
        </div>
      </form>`
    const form = overlay.querySelector('form')!
    const input = overlay.querySelector('input')!
    const err = overlay.querySelector('[data-err]') as HTMLElement
    const submit = overlay.querySelector('button[type=submit]') as HTMLButtonElement

    const finish = (ok: boolean) => {
      overlay.remove()
      document.removeEventListener('keydown', onKey)
      pending = null
      resolve(ok)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false) }
    document.addEventListener('keydown', onKey)
    overlay.querySelector('[data-cancel]')!.addEventListener('click', () => finish(false))

    form.addEventListener('submit', async e => {
      e.preventDefault()
      err.textContent = ''
      submit.disabled = true
      submit.textContent = 'Checking…'
      try {
        const res = await fetch('/api/auth/reauth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(totp ? { code: input.value.trim() } : { password: input.value }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok) return finish(true)
        err.textContent = data?.error || 'That did not work. Try again.'
      } catch {
        err.textContent = 'Network error — try again.'
      }
      submit.disabled = false
      submit.textContent = 'Confirm'
      input.select()
    })

    document.body.appendChild(overlay)
    input.focus()
  })
  return pending
}

/** fetch() that transparently handles the password re-prompt once. */
export async function fetchWithReauth(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (res.status !== 403) return res
  const data: any = await res.clone().json().catch(() => ({}))
  if (data?.code !== 'reauth_required') return res
  if (!(await promptForPassword(data?.method === 'totp' ? 'totp' : 'password'))) return res
  return fetch(url, init)
}
