'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import clsx from 'clsx'

const userNav = [
  { label: 'Overview',      href: '/dashboard' },
  { label: 'My Proxies',    href: '/dashboard/proxies' },
  { label: 'Buy Bandwidth', href: '/dashboard/buy' },
  { label: 'Usage',         href: '/dashboard/usage' },
  { label: 'Billing',       href: '/dashboard/billing' },
  { label: 'Referrals',     href: '/dashboard/referrals' },
  { label: 'Settings',      href: '/dashboard/settings' },
]

const resellerNav = [
  { label: 'Overview',      href: '/dashboard' },
  { label: 'My Stock',      href: '/dashboard/proxies' },
  { label: 'Sub-users',     href: '/reseller/users' },
  { label: 'Transfers',     href: '/reseller/transfers' },
  { label: 'Buy Bandwidth', href: '/dashboard/buy' },
  { label: 'Usage',         href: '/dashboard/usage' },
  { label: 'Stock & Activity', href: '/reseller/earnings' },
  { label: 'Billing',       href: '/dashboard/billing' },
  { label: 'Referrals',     href: '/dashboard/referrals' },
  { label: 'Settings',      href: '/dashboard/settings' },
]

// API Keys only injected if api_access is true (handled below)
const apiKeyItem = { label: 'API Keys', href: '/dashboard/api-keys' }

type NavItem = { label: string; href: string }
// Insert by label rather than by array index: the index-based slices that used
// to do this broke silently whenever an item was added to a list (the reseller
// list gained no Usage link for exactly that kind of reason).
function insertBefore(list: NavItem[], beforeLabel: string, item: NavItem): NavItem[] {
  const i = list.findIndex(n => n.label === beforeLabel)
  return i === -1 ? [...list, item] : [...list.slice(0, i), item, ...list.slice(i)]
}

const adminNav = [
  { label: 'Overview',    href: '/admin' },
  { label: 'All Users',   href: '/admin/users' },
  { label: 'Orders',      href: '/admin/orders' },
  { label: 'Resellers',   href: '/admin/resellers' },
  { label: 'Credentials', href: '/admin/credentials' },
  { label: 'Support',     href: '/admin/support' },
  { label: 'Banned Emails', href: '/admin/bans' },
  { label: 'Affiliates',  href: '/admin/affiliates' },
  { label: 'Sales Cycles', href: '/admin/cycles' },
  { label: 'Audit Log',   href: '/admin/audit' },
  { label: 'Settings',    href: '/admin/settings' },
]

interface Props {
  role: string
  // Shown at the top of the mobile drawer — the topbar hides the address below `md`.
  email?: string | null
  // Mobile drawer state — below `md` the sidebar is an off-canvas drawer
  // opened from the topbar's menu button. Fixed w-56 with no responsive
  // behaviour used to eat 224px of a 375px phone.
  open?: boolean
  onClose?: () => void
}

// Overview-style roots must match exactly (every other dashboard URL starts
// with /dashboard); everything else matches on its own subtree, so
// /dashboard/proxies/new keeps "My Proxies" highlighted. Exact matching left
// the sidebar with NO active item on any nested page.
const ROOTS = new Set(['/dashboard', '/admin'])
function isActive(path: string, href: string): boolean {
  if (ROOTS.has(href)) return path === href
  return path === href || path.startsWith(href + '/')
}

export default function DashSidebar({ role, email, open = false, onClose }: Props) {
  const path = usePathname()

  // Close the drawer when navigating, and on Escape.
  useEffect(() => { onClose?.() }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  let nav: NavItem[] = role === 'admin' ? adminNav : role === 'reseller' ? resellerNav : userNav

  // API Keys nav item shown for every reseller, not just ones who already
  // have api_access — previously this was gated on `apiAccess`, which
  // meant a reseller with no access had literally no path to discover
  // that API access exists or that they could ask for it; the page
  // itself has always explained this and offered a way to apply, it was
  // just unreachable via nav. Admin still always sees it (has access
  // unconditionally).
  if (role === 'reseller') {
    nav = insertBefore(resellerNav, 'Billing', apiKeyItem)
  }
  if (role === 'admin') {
    nav = insertBefore(adminNav, 'Support', apiKeyItem) // after Credentials
  }

  // An admin browsing their OWN account pages (/dashboard/*) used to be shown
  // only the admin nav — no way to reach their proxies, billing or settings.
  // /dashboard/api-keys is linked from the admin nav itself: keep the admin nav there instead of flipping the whole sidebar.
  const adminOnOwnAccount = role === 'admin' && path.startsWith('/dashboard') && path !== '/dashboard/api-keys'
  if (adminOnOwnAccount) {
    nav = [...insertBefore(userNav, 'Settings', apiKeyItem), { label: '← Admin Panel', href: '/admin' }]
  }

  const label = adminOnOwnAccount ? 'My Account' : role === 'admin' ? 'Admin Panel' : role === 'reseller' ? 'Reseller Panel' : 'My Account'

  return (
    <>
    {open && <div className="fixed inset-0 top-16 bg-ink/40 z-30 md:hidden" onClick={onClose} aria-hidden="true" />}
    <aside
      id="dash-sidebar"
      className={clsx(
        'w-56 bg-white border-r border-border flex-shrink-0 flex-col py-6',
        // md+: normal in-flow column. Below md: fixed drawer under the topbar.
        // md+: sticky under the topbar and scrolls on its own when the nav is
        // taller than the viewport (the drawer used to cut items off on short
        // screens). Below md the drawer scrolls too.
        'overflow-y-auto md:flex md:sticky md:top-16 md:bottom-auto md:self-start md:h-[calc(100vh-4rem)] md:translate-x-0',
        open ? 'flex fixed top-16 bottom-0 left-0 z-40 shadow-xl' : 'hidden'
      )}>
      <nav className="flex flex-col gap-0.5 px-3 flex-1">
        {email && <div className="md:hidden text-xs text-ink2 px-3 pb-2 truncate" title={email}>{email}</div>}
        <div className="text-[10px] font-mono text-muted uppercase tracking-widest px-3 pb-3">{label}</div>
        {nav.map(item => (
          <Link key={item.href} href={item.href}
            aria-current={isActive(path, item.href) ? 'page' : undefined}
            className={clsx(
              'flex items-center px-3 py-2.5 rounded-xl text-sm transition-all',
              isActive(path, item.href)
                ? 'bg-accent-light text-accent font-medium'
                : 'text-ink2 hover:bg-surface hover:text-ink'
            )}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="px-3 pt-4 border-t border-border mx-3">
        {role === 'admin' && !adminOnOwnAccount ? (
          <a href="mailto:support@globproxy.com"
            className="flex items-center px-3 py-2.5 rounded-xl text-sm text-muted hover:text-ink hover:bg-surface transition-all">
            Support
          </a>
        ) : (
          <Link href="/dashboard/support"
            aria-current={isActive(path, '/dashboard/support') ? 'page' : undefined}
            className={clsx(
              'flex items-center px-3 py-2.5 rounded-xl text-sm transition-all',
              isActive(path, '/dashboard/support') ? 'bg-accent-light text-accent font-medium' : 'text-muted hover:text-ink hover:bg-surface'
            )}>
            Support
          </Link>
        )}
      </div>
    </aside>
    </>
  )
}
