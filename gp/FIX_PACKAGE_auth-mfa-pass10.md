# Auth & MFA — pass 10

1. Dormant-account sign-in alert: `recordLogin` no longer limits "has signed in before" to 180 days (lib/securityEvents.ts).
2. Migrations 0073 and 0092 now register themselves in schema_migrations (files + schema.sql for 0073).
3. 0095: `confirm_totp_enrollment_atomic` compare-and-sets on the verified secret (lib/mfa.ts passes `p_expected_secret`). APPLY 0095 BEFORE/WITH the deploy.
4. Administrators can no longer use self-service 2FA recovery (request / confirm / complete); they need an admin reset.
5. Recovery: the "started" notice must send or the waiting period is rolled back; "2FA removed" notice is now durable (recordAndNotify + DURABLE_NOTICE_EVENTS).
6. 2FA code inputs in Settings no longer strip spaces while typing.
