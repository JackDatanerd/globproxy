// Our SQL functions signal user-facing problems with a plain RAISE EXCEPTION
// (SQLSTATE P0001) and a message written for humans ("Insufficient bandwidth…",
// "This credential was allocated by your reseller…"). Anything else coming out
// of an RPC — a constraint violation, a type error, a missing column — carries
// raw Postgres text (table and column names, "violates check constraint …")
// that must never reach a customer. Routes pass the error through this: our own
// messages survive, everything else becomes the supplied generic fallback.
export function rpcUserMessage(error: { code?: string | null; message?: string | null } | null | undefined, fallback: string): string {
  return error?.code === 'P0001' && error.message ? error.message : fallback
}
