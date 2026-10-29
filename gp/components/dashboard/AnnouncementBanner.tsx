'use client'

import { useEffect, useState } from 'react'

interface Item { id: string; kind: 'marketing' | 'service'; title: string; text: string; cta_label: string | null; cta_url: string | null }

// Announcements the admin sent with "show a banner" (Admin → Broadcasts). Dismissal is remembered per
// browser and per account, like MfaRecommendBanner. A failure to load shows nothing — never an error
// on the dashboard.
export default function AnnouncementBanner() {
  const [items, setItems] = useState<Item[]>([])
  const [userId, setUserId] = useState<string | null>(null)
  const key = (uid: string) => `gp_announce_dismissed:${uid}`

  useEffect(() => {
    let cancelled = false
    fetch('/api/dashboard/announcements', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (cancelled || !d || !Array.isArray(d.items)) return
        let dismissed: string[] = []
        try { dismissed = JSON.parse(localStorage.getItem(key(d.userId)) ?? '[]') } catch { /* private mode */ }
        setUserId(d.userId)
        setItems(d.items.filter((i: Item) => !dismissed.includes(i.id)))
      })
      .catch(() => { /* cosmetic */ })
    return () => { cancelled = true }
  }, [])

  function dismiss(id: string) {
    setItems(list => list.filter(i => i.id !== id))
    if (!userId) return
    try {
      const cur: string[] = JSON.parse(localStorage.getItem(key(userId)) ?? '[]')
      localStorage.setItem(key(userId), JSON.stringify([...cur, id].slice(-30)))
    } catch { /* private mode */ }
  }

  if (!items.length) return null
  return (
    <>
      {items.map(i => (
        <div key={i.id} className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-accent/20 bg-accent-light px-4 py-3">
          <p className="flex-1 min-w-[220px] text-sm text-ink2">
            <span className="font-semibold text-ink">{i.title}</span>{' '}{i.text}
          </p>
          {i.cta_label && i.cta_url && (
            <a href={i.cta_url} className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:opacity-90">{i.cta_label}</a>
          )}
          <button onClick={() => dismiss(i.id)} className="text-xs text-muted hover:text-ink2" aria-label="Dismiss">Dismiss</button>
        </div>
      ))}
    </>
  )
}
