# Proxy lifecycle (Section 4) bug pass

- Allocation drift detector (migration 0113 + lib/allocationDrift.ts, daily cleanup cron): reports accounts whose reserved GB no session explains (interrupted create). Alert-only.
- Top-up: fixed neutral text for insufficient-balance and reseller errors (no raw database text).
- Pause / delete-freeze caps carry the 1 MB headroom; provisioning top-up cap is an integer MB via expectedLimitMb.
- Capacity classifier no longer treats plain validation errors containing "available"/"exceed"/"allocat" as capacity.
- Whitelist mirror re-reads the supplier list even without the lock and never writes a list it could not verify (marks stale for the backfill).
- Customers cannot delete admin/account-suspended sessions for a refund.
- Live usage refresh CAS handles a NULL counter.
- my-ip returns the address family; the whitelist page warns on IPv6.
- Dashboard alert-level clamp matches the server bounds (warn >= 50, urgent <= 99).
- Tests: tests/proxy-lifecycle-section4.test.mjs. Apply migration 0113.
