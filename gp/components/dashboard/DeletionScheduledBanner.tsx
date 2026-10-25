import Link from 'next/link'

// Shown on every dashboard page while the account's deletion is scheduled. The owner is
// e-mailed when it is scheduled and a day before, but someone who got into the account and
// scheduled it would otherwise be visible only on the Settings page.
export default function DeletionScheduledBanner({ when }: { when: string }) {
  const d = new Date(when)
  const label = Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'soon'
  return (
    <div className="mb-5 flex items-center justify-between gap-3 flex-wrap rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <span>This account is scheduled to be permanently deleted on <strong>{label}</strong>. Didn&apos;t ask for this? Cancel it and change your password.</span>
      <Link href="/dashboard/settings#delete-account" className="text-xs font-mono underline whitespace-nowrap">Cancel deletion →</Link>
    </div>
  )
}
