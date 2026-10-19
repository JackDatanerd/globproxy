// PostgREST (Supabase) silently caps every select at 1000 rows by default —
// no error, just a truncated result. Every full-table scan in the proxy
// lifecycle (usage sync, auto-top-up candidates, stock exposure, limit
// reconciliation) used a plain select, so past 1000 credentials the extras
// were silently never synced / topped up / counted. This walks a query in
// fixed-size pages instead.
//
// `build` must return a FRESH query each call (a builder can't be reused
// after being awaited) and must include a stable `.order(...)`, otherwise
// rows can shift between pages.
const PAGE = 1000
const MAX_PAGES = 200 // 200k rows — runaway guard

export async function fetchAllRows<T = any>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) return { rows, error: error.message }
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) return { rows, error: null }
  }
  return { rows, error: 'fetchAllRows hit MAX_PAGES' }
}
