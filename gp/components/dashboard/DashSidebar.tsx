'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

const userNav = [
  { label: 'Overview',      href: '/dashboard' },
  { label: 'My Proxies',    href: '/dashboard/proxies' },
  { label: 'Buy Bandwidth', href: '/dashboard/buy' },
  { label: 'Usage',         href: '/dashboard/usage' },
  { label: 'Billing',       href: '/dashboard/billing' },
  { label: 'Settings',      href: '/dashboard/settings' },
]

const resellerNav = [
  { label: 'Overview',      href: '/dashboard' },
  { label: 'My Stock',      href: '/dashboard/proxies' },
  { label: 'Sub-users',     href: '/reseller/users' },
  { label: 'Transfers',     href: '/reseller/transfers' },
  { label: 'Buy Wholesale', href: '/dashboard/buy' },
  { label: 'Earnings',      href: '/reseller/earnings' },
  { label: 'Billing',       href: '/dashboard/billing' },
  { label: 'Settings',      href: '/dashboard/settings' },
]

// API Keys only injected if api_access is true (handled below)
const apiKeyItem = { label: 'API Keys', href: '/dashboard/api-keys' }

const adminNav = [
  { label: 'Overview',    href: '/admin' },
  { label: 'All Users',   href: '/admin/users' },
  { label: 'Orders',      href: '/admin/orders' },
  { label: 'Resellers',   href: '/admin/resellers' },
  { label: 'Credentials', href: '/admin/credentials' },
  { label: 'Settings',    href: '/admin/settings' },
]

interface Props {
  role: string
  apiAccess?: boolean
}

export default function DashSidebar({ role, apiAccess = false }: Props) {
  const path = usePathname()

  let nav = role === 'admin' ? adminNav : role === 'reseller' ? resellerNav : userNav

  // API Keys nav item shown for every reseller, not just ones who already
  // have api_access — previously this was gated on `apiAccess`, which
  // meant a reseller with no access had literally no path to discover
  // that API access exists or that they could ask for it; the page
  // itself has always explained this and offered a way to apply, it was
  // just unreachable via nav. Admin still always sees it (has access
  // unconditionally).
  if (role === 'reseller') {
    nav = [
      ...resellerNav.slice(0, 6), // up to Earnings
      apiKeyItem,
      ...resellerNav.slice(6),    // Billing, Settings
    ]
  }
  if (role === 'admin') {
    nav = [...adminNav.slice(0, 5), apiKeyItem, ...adminNav.slice(5)] // up to Credentials, then API Keys, then Settings
  }

  const label = role === 'admin' ? 'Admin Panel' : role === 'reseller' ? 'Reseller Panel' : 'My Account'

  return (
    <aside className="w-56 bg-white border-r border-border flex-shrink-0 flex flex-col py-6">
      <nav className="flex flex-col gap-0.5 px-3 flex-1">
        <div className="text-[10px] font-mono text-muted uppercase tracking-widest px-3 pb-3">{label}</div>
        {nav.map(item => (
          <Link key={item.href} href={item.href}
            className={clsx(
              'flex items-center px-3 py-2.5 rounded-xl text-sm transition-all',
              path === item.href
                ? 'bg-accent-light text-accent font-medium'
                : 'text-ink2 hover:bg-surface hover:text-ink'
            )}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="px-3 pt-4 border-t border-border mx-3">
        <a href="mailto:support@globproxy.com"
          className="flex items-center px-3 py-2.5 rounded-xl text-sm text-muted hover:text-ink hover:bg-surface transition-all">
          Support
        </a>
      </div>
    </aside>
  )
}
