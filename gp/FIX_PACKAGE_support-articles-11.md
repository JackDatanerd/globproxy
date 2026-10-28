# Support articles, bit 11: API quickstart

New help article `api-quickstart-create-first-sub-user` (Guides, section: help), listed on the /help hub under a new topic, "Resellers and the API".

Covers: getting reseller and API access (the Request API access form and its states), creating a key (access levels, expiry, allowed IPs, shown once, "Done, I've saved it"), checking the key with /account and /account/bandwidth, creating a sub-user with curl and an Idempotency-Key, reading the response (connection_username, ports 9000/10000/11000/12000), the pending state and session_activated webhook, usage and top-up, the common error codes and rate limits, and what to send support (X-Request-Id).

Checked against: app/dashboard/api-keys/* (labels, gating), app/api/v1/sub-users/route.ts, lib/credentials.ts (response shape), lib/apiAuth.ts (scopes, 403 codes, 25-key and 20-IP limits), lib/apiValidation.ts (GB bounds), lib/proxyEndpoint.ts (ports) and the API docs page.

Files: gp/lib/blog/posts.ts, gp/lib/blog/help.ts, this note. No supplier name or "upstream" in the copy (tests/help-section.test.mjs enforces it). tsc clean; 217/217 tests pass.

Not changed (noted only): none new.
