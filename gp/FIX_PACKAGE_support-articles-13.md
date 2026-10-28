# Support articles, bit 13: managing a session's IP whitelist

New help article `manage-session-ip-whitelist-add-remove-errors` (Guides, section: help), listed under "Sessions and targeting" on /help.

Scope, by decision: it covers USING the IP whitelist tab (add, bulk add up to 150, remove, what is accepted, how to find the right public IP, every message, reseller API pointers) and deliberately makes NO claim about whether other IPs are blocked. The code does not show it and components/dashboard/IpWhitelist.tsx records that it was never tested live. The article says the list is an extra setting and not a substitute for keeping credentials private.

Checked against: components/dashboard/IpWhitelist.tsx, app/api/dashboard/proxies/[id]/whitelist (+ bulk), app/api/dashboard/my-ip, lib/ipWhitelist.ts (validation, private-range refusal, error texts), lib/whitelistMirror.ts (saved copy and replay), lib/webhookEvents.ts.

Open finding, NOT fixed (not asked): the older post `ip-whitelisting-client-proxy-credentials` still says a credential is "usable from anywhere by anyone who has it" without a whitelist and calls whitelisting "the cheapest fix", and the how-to-connect article says "no whitelist step". Neither claim has been verified live. A one-off test (connect from a non-listed IP with valid credentials) would settle it, after which the post can be corrected.

Files: gp/lib/blog/posts.ts, gp/lib/blog/help.ts, this note. tsc clean; 228/228 tests pass. Built on f445514.
