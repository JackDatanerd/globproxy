# Support articles, bit 8: "IP lookup shows the wrong city"

Built on `3de3264`. Changes: `lib/blog/posts.ts` (new article) and `lib/blog/help.ts` (listed on /help under "Sessions and targeting"). No migration, no env change.

## Article added (help centre, Geo-Targeting)
- `/help/ip-lookup-shows-wrong-city-proxy-location`: "IP Lookup Shows the Wrong City? How to Check Your Proxy's Location" (~5 min, 6 FAQs).
- Covers: why lookup sites disagree (estimates; country > state > city reliability), confirming the session really targets a city (Edit tab, Username suffix, new connections only), a copy-paste 5-run test loop, a result table (same city / nearby town / different state / different country / your own location), testing what the real target site sees, getting a specific city to be right (sticky named sessions, keep the matching ones), widening the target, and exactly what to send support.
- Every on-screen label, the username example (against `buildProxyUsername`) and the "remove" semantics were asserted against the code; the shell snippet passes `bash -n` and was run against a stubbed curl. No supplier name, no "upstream". Description 155, title 66.

## Checks
tsc clean, supplier-leak OK, 195 tests pass (the help-section test confirms the hub lists the new article).

## Notes
- The article makes no claim about how the network sources its locations, only that lookup databases are estimates.
- It does not promise refunds or fixes for wrong cities; it sends real problems (wrong country/state on repeated tests) to Support with the details we need.
