// Shown when a list query FAILED. These pages used to read `data` only, so a
// failed query (timeout, dropped connection, missing migration) rendered as an
// empty list — "No orders match." — and an admin could act on a false "nothing
// here". A failure now says so, in red, above the list.
export default function AdminQueryError({ what }: { what: string }) {
  return (
    <div role="alert" className="mb-6 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
      Couldn&apos;t load {what} — the list below is <strong>not</strong> the full picture (an empty list here does not mean there are none). Reload to retry.
    </div>
  )
}
