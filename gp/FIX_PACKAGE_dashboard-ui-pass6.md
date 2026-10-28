# Dashboard UI — independent pass (bugs only)

1. Bulk top-up: budget check now allows +0.005 GB (float dust blocked e.g. 3 x 0.1 against 0.30 GB). `components/dashboard/ProxyList.tsx`
2. Refund request: 403 `mfa_required` now redirects to 2FA verification instead of a bare error toast. `app/dashboard/billing/page.tsx`
3. Bulk retarget confirm text: only sessions in a different country have state/city/ASN cleared. `ProxyList.tsx`
4. A declined re-auth prompt no longer shows a red "Confirmation is required" toast; handlers use `toastApiError`. 13 dashboard files.
5. New-session page: a failed balance lookup shows an error instead of redirecting to Buy ("no bandwidth"). `app/dashboard/proxies/new/page.tsx`
6. `session_low` webhook label now matches configurable alert levels. `lib/webhookEvents.ts`

Tests: `tests/dashboard-ui-pass6.test.mjs`.
