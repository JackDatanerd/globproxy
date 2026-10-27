# Support articles — bit 5: Auto-allocate + Auto-recharge guide

Built on `28241b2`. Only `lib/blog/posts.ts` changes. No migration, no env change.

## Article added (Guides)
`/blog/auto-allocate-and-auto-recharge-never-run-dry` — the two features customers confuse: **auto-allocate** (moves GB from the unassigned balance onto one session; free) vs **auto-recharge** (buys a plan with a saved card; capped per rolling 30 days). Comparison table, setup steps for both, the rules, how often each checks (~5 min), why the trigger level needs a cushion, sizing table, the four "balance is short" outcomes, safeguards, using both as a chain, a 7-row problems table, FAQ.

Every number in the article is asserted against the code in the check: threshold 1–500 GB, custom plan 1–499 GB, cap $1–$5,000 per 30 days, 30-minute cooldown between attempts, 3 consecutive failures switch it off, 100,000 GB session ceiling (`rechargeRules`, `plans`, `apiValidation`, `set_auto_topup`, `auto_topup_credential`, `autoTopup`).

## Deliberately framed as guidance, not guarantees
The sizing table (trigger ≥ ~10 minutes of peak use) is arithmetic on the customer's own peak rate plus the ~5-minute check cadence, and says so.

## Checked
`tsc --noEmit` clean; `npm test` 155/155; supplier-leak ratchet OK; render check passes for all five guides; meta description 148 chars (a first draft was 167 and was trimmed).

## Found, not changed
Three older posts have meta descriptions over the ~160 characters `lib/blog/types.ts` asks for (`city-level-proxy-targeting-explained` 190, `ad-verification-geo-targeted-proxies` 172, `non-expiring-proxy-bandwidth` 169): search results will truncate them.
