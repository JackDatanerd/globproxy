# Dashboard UI — pass 5 (bugs only)

1. The bulk-action bar (My Proxies) and the new-session summary stuck BEHIND the
   64px topbar (`sticky top-2` / `lg:top-6` vs a `sticky top-0 z-40 h-16`
   header), so the bar vanished as soon as the list was scrolled. Offsets now
   clear the topbar. (ProxyList.tsx, NewProxyForm.tsx)
2. Scheduling or cancelling account deletion now calls `router.refresh()`: the
   red "scheduled for deletion" banner is rendered by the server layout and
   stayed (or never appeared) until a hard reload. (settings/page.tsx)
3. "Download my data" no longer sticks on "Preparing…" when the re-auth dialog
   is cancelled: `setExporting(false)` moved into `finally`. (settings/page.tsx)
4. Cancelling the re-auth dialog during a bulk action stops the run quietly
   (no per-chunk re-prompt, no "Couldn't pause N" failure toast) and keeps the
   untouched sessions selected. (ProxyList.tsx)
5. The customer's own alert levels (Settings) now drive the card's rail, usage
   bar, Bandwidth tab dot and "Remaining" colour, and the Usage page's
   per-session bars, matching the banners. (ProxyCard.tsx, ProxyList.tsx,
   usage/page.tsx)
6. "Export URLs" writes `socks5h://` for SOCKS5 sessions (proxy-side DNS), like
   every code snippet. (ProxyList.tsx)
7. Edit tab: the previous country's regions are dropped the moment the country
   changes, so one cannot be picked and saved for the wrong country.
   (CredentialSettings.tsx)

Small:
- Auto-allocate on a session card refuses an EMPTY threshold instead of
  silently saving 0. (ProxyCard.tsx)
- "Sign out other devices" refreshes the "Where you're signed in" list.
  (AccountSecurityCards.tsx)
- Usage-banner dismissals are stored per account; the "(+N hidden)" selection
  note ignores sessions deleted meanwhile. (ProxyList.tsx, proxies/page.tsx)

No migrations. Type check (tsc --noEmit) clean; tests/dashboard-ui-pass5.test.mjs.
