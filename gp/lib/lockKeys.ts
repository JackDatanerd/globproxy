// Internal lock keys share api_idempotency_keys with customer Idempotency-Keys, so they must be
// impossible to send as one: '#' is outside the accepted alphabet (lib/idempotency.ts KEY_RE).
// With the old "delete:<id>" form a customer could send exactly that string as their own key and make
// their own session look like it was being deleted (suppressing its limit syncs for two minutes).
export const internalLockKey = (kind: string, id: string) => `lock#${kind}#${id}`
