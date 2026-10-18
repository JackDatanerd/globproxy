'use client'

import { useEffect, useRef } from 'react'

// Cloudflare Turnstile widget. Renders nothing (and onToken is never called)
// unless NEXT_PUBLIC_TURNSTILE_SITE_KEY was set at build time — the server
// side (lib/turnstile.ts) is likewise a no-op without TURNSTILE_SECRET_KEY,
// so the whole feature turns on by setting the two env vars.
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
export const turnstileConfigured = !!SITE_KEY

declare global {
  interface Window { turnstile?: any }
}

const SCRIPT_ID = 'cf-turnstile-script'

export default function Turnstile({ onToken, resetSignal = 0 }: { onToken: (token: string | null) => void; resetSignal?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)
  const cb = useRef(onToken)
  cb.current = onToken

  useEffect(() => {
    if (!SITE_KEY) return
    if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement('script')
      s.id = SCRIPT_ID
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      s.async = true
      s.defer = true
      document.head.appendChild(s)
    }
    let cancelled = false
    const timer = setInterval(() => {
      if (cancelled || !window.turnstile || !box.current || widgetId.current !== null) return
      widgetId.current = window.turnstile.render(box.current, {
        sitekey: SITE_KEY,
        callback: (t: string) => cb.current(t),
        'expired-callback': () => cb.current(null),
        'error-callback': () => cb.current(null),
      })
      clearInterval(timer)
    }, 150)
    return () => {
      cancelled = true
      clearInterval(timer)
      if (widgetId.current !== null && window.turnstile) {
        try { window.turnstile.remove(widgetId.current) } catch { /* already gone */ }
        widgetId.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (resetSignal > 0 && widgetId.current !== null && window.turnstile) {
      cb.current(null)
      try { window.turnstile.reset(widgetId.current) } catch { /* ignore */ }
    }
  }, [resetSignal])

  if (!SITE_KEY) return null
  return <div ref={box} className="flex justify-center" />
}
