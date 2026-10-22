// Decides whether an error from supabase.auth.getUser() means "the auth backend
// is having trouble" (serve a 503 / keep the visitor's cookies) or "this visitor
// really has no valid session" (send them to log in). Pure, so it is unit-tested
// on its own; used by middleware.ts.
//
// getUser() returns `user: null` for both, so the error is the only signal:
//  - AuthSessionMissingError and 4xx API errors (bad / expired JWT, 401, 403) are a
//    genuine "not signed in".
//  - AuthRetryableFetchError is supabase-js's own name for a network failure or a
//    502/503/504/52x answer.
//  - AuthUnknownError is what supabase-js produces when an error answer's body is
//    NOT JSON — e.g. a 500 or 52x HTML page from the edge in front of Supabase.
//    It carries no status, so a status-only check read it as "logged out" and
//    bounced signed-in users to the login form in the middle of an outage.
//  - 429 (Supabase rate-limiting this Worker) and 408 are a backend problem, not
//    a verdict on the visitor.
export function isAuthOutage(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: unknown; status?: unknown }
  if (e.name === 'AuthSessionMissingError') return false
  if (e.name === 'AuthRetryableFetchError' || e.name === 'AuthUnknownError') return true
  if (typeof e.status === 'number') return e.status >= 500 || e.status === 429 || e.status === 408
  return false
}
