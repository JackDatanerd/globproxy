// Single source of truth for plan pricing.
//
// Previously this was defined three separate times — app/api/checkout/route.ts
// (server), app/dashboard/buy/page.tsx (client), and components/PricingPlans.tsx
// (marketing page) — with no guarantee any two of them stayed in sync. The
// marketing/buy pages also listed a "Scale" tier that didn't exist in the
// server's copy at all (harmless only because the UI intercepts "Scale"
// clicks into a mailto: link before ever hitting /api/checkout). The `plans`
// DB table exists but nothing in the app actually reads from it — this file,
// not the table, is the real source of truth today.

export type PlanSlug = 'micro' | 'starter' | 'growth' | 'scale'

export interface Plan {
  slug: PlanSlug
  name: string
  gb: number
  price: number // $ per GB
  total: number // total $ for this plan
  tagline?: string
  badge?: string
  savings?: string
  featured?: boolean
  features?: string[]
  // true = not sold through /api/checkout — "Contact us" / mailto flow only.
  custom?: boolean
}

export const PLANS: Plan[] = [
  {
    slug: 'micro',
    name: 'Micro',
    gb: 1,
    price: 4.50,
    total: 4.50,
    badge: 'pay-as-you-go',
    tagline: 'For testing & pay-as-you-go',
    features: ['1 GB non-expiring bandwidth', '195 countries', 'Rotating & sticky sessions', 'Dashboard access', 'Email support'],
  },
  {
    slug: 'starter',
    name: 'Starter',
    gb: 10,
    price: 3.50,
    total: 35.00,
    tagline: 'For testing & small projects',
    features: ['10 GB non-expiring bandwidth', '195 countries', 'Rotating & sticky sessions', 'Dashboard access', 'Email support'],
  },
  {
    slug: 'growth',
    name: 'Growth',
    gb: 100,
    price: 2.80,
    total: 280.00,
    tagline: 'For agencies & power users',
    savings: 'Save 20%',
    featured: true,
    features: ['100 GB non-expiring bandwidth', 'City-level targeting', 'Reseller API & sub-user management (by application)', 'Priority support'],
  },
  {
    slug: 'scale',
    name: 'Scale',
    gb: 500,
    price: 2.00,
    total: 1000,
    tagline: 'High-volume operations',
    savings: 'Save 43%',
    features: ['500 GB+ non-expiring bandwidth', 'Custom geo allocation', 'Dedicated account manager', 'White-label credentials', '24/7 priority support'],
    custom: true,
  },
]

export function getPlan(slug: string): Plan | undefined {
  return PLANS.find(p => p.slug === slug)
}

// Only plans actually purchasable through /api/checkout — excludes `custom`
// (contact-sales-only) tiers like Scale.
export function getPurchasablePlan(slug: string): Plan | undefined {
  const plan = getPlan(slug)
  return plan && !plan.custom ? plan : undefined
}
