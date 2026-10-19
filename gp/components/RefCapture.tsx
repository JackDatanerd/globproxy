'use client'
import { useEffect } from 'react'

// Persists a ?ref= (and optional ?sub=) seen on ANY page for 60 days, so an
// affiliate's referral still counts when the visitor browses pricing/docs
// first and signs up later (or comes back another day). First-touch wins:
// an existing cookie is never overwritten by a different code.
const CODE_RE = /^[A-Za-z0-9]{4,32}$/
const SUB_RE = /^[A-Za-z0-9_-]{1,32}$/
const MAX_AGE = 60 * 60 * 24 * 60

export default function RefCapture() {
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search)
      const ref = q.get('ref')?.trim()
      if (!ref || !CODE_RE.test(ref)) return
      if (/(?:^|; )gp_ref=/.test(document.cookie)) return
      const secure = window.location.protocol === 'https:' ? '; Secure' : ''
      document.cookie = `gp_ref=${encodeURIComponent(ref.toUpperCase())}; Max-Age=${MAX_AGE}; Path=/; SameSite=Lax${secure}`
      const sub = q.get('sub')?.trim()
      if (sub && SUB_RE.test(sub)) {
        document.cookie = `gp_sub=${encodeURIComponent(sub)}; Max-Age=${MAX_AGE}; Path=/; SameSite=Lax${secure}`
      }
    } catch {
      /* cookies disabled — attribution falls back to the URL param on the signup page */
    }
  }, [])
  return null
}
