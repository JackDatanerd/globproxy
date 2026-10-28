# Support articles, bit 9: "Usage and remaining GB don't match"

Built on `3de3264`. Changes: `lib/blog/posts.ts`, `lib/blog/help.ts`. No migration, no env change.

**This package is cumulative: it also contains bit 8 ("IP lookup shows the wrong city").** Both edit the same two files, so extracting it over bit 8 is safe, and extracting it without bit 8 still gives you both. (Its note, FIX_PACKAGE_support-articles-8.md, is included.)

## Article added (help centre, Bandwidth & Pricing)
- `/help/usage-and-remaining-gb-not-matching`: "Usage and Remaining GB Don't Match? Where Each Number Comes From" (~5 min, 6 FAQs). Listed on /help under "Bandwidth and payments".
- Explains the five figures (session Remaining, Total purchased, Used, account Remaining / "Bandwidth left", Free to assign) and how they add up (account Remaining = sum of session Remaining + Free to assign; checked against the delete/allocate accounting in migrations 0009/0040/0064), the ~5 minute update cycle, Refresh usage (30 s floor, active sessions only; session updates at once, account totals at the next update), why pages can disagree (deleted and paused sessions, 2-decimal rounding, update timing, UTC days, chart and host list from a different report), where GB went (Usage over time, Top hosts & countries, Export full CSV), usage alerts (Settings, defaults 80/95, amber/red), and what to send support.
- All on-screen labels and toasts asserted against the code; the 30 s constant read from lib/usageLive.ts. No supplier name, no "upstream". Description 155, title 64.

## Checks
tsc clean, supplier-leak OK, 195 tests pass (help-section test confirms the hub lists both new articles).

## Notes
- The article makes no claim about exactly what bytes are metered, because nothing in the app states it; it only says that anything sent through the proxy uses bandwidth.
- Observation, not changed: Refresh usage on a non-active session answers "Already up to date" even though nothing was read. Harmless, but slightly misleading.
