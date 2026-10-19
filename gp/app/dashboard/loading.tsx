export default function DashboardLoading() {
  return (
    <div className="max-w-4xl animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="h-7 w-48 bg-border/60 rounded-lg mb-3" />
      <div className="h-4 w-72 bg-border/40 rounded mb-8" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[0, 1, 2, 3].map(i => <div key={i} className="h-24 bg-white border border-border rounded-xl" />)}
      </div>
      <div className="h-48 bg-white border border-border rounded-xl" />
    </div>
  )
}
