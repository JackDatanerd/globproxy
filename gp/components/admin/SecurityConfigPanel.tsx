import type { SecurityCheck } from '@/lib/securityConfig'

const DOT: Record<SecurityCheck['status'], string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  fail: 'bg-red-500',
}

// Server component. Booleans and counts only — see lib/securityConfig.ts.
export default function SecurityConfigPanel({ checks }: { checks: SecurityCheck[] }) {
  return (
    <div className="bg-white border border-border rounded-xl p-6 mt-5">
      <h2 className="font-display font-bold text-base text-ink mb-1">Sign-in &amp; 2FA configuration</h2>
      <p className="text-xs text-muted font-light mb-4">
        Settings that fail quietly when missing. Red or amber rows mean the platform is running in a weaker mode than intended.
      </p>
      <ul className="flex flex-col gap-3">
        {checks.map((c) => (
          <li key={c.id} className="flex gap-3 items-start">
            <span className={`mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 ${DOT[c.status]}`} aria-label={c.status} />
            <div>
              <div className="text-sm font-medium text-ink">{c.label}</div>
              <div className="text-xs text-muted break-words">{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
