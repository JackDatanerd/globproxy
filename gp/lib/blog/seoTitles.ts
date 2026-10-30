// Search-result titles. A post's own `title` is written as a headline (the page <h1>), and with the
// " — GlobProxy" suffix every one of them ran past ~60 characters, so Google cut them mid-phrase.
// Each post gets a short SEO title here instead; the full headline stays on the page, in Open Graph
// and in the Article JSON-LD. Keep every entry <= SEO_TITLE_MAX once the suffix is added
// (tests/public-seo.test.mjs enforces this and that no slug is missing or orphaned).
// Plain data, no imports, so the tests can load it directly.
export const SEO_TITLE_SUFFIX = ' — GlobProxy'
export const SEO_TITLE_MAX = 60

export const SEO_TITLES: Record<string, string> = {
  // help
  'manage-session-ip-whitelist-add-remove-errors': "Manage a Session's IP Whitelist: Add and Remove",
  'cant-sign-in-forgot-password-reset-link-problems': "Can't Sign In? Password Reset and Lockout Help",
  'api-quickstart-create-first-sub-user': 'API Quickstart: Create Your First Sub-User',
  'request-a-refund-eligibility-and-timeline': 'How to Request a Refund: Eligibility and Steps',
  'usage-and-remaining-gb-not-matching': "Usage and Remaining GB Don't Match? Here's Why",
  'ip-lookup-shows-wrong-city-proxy-location': 'IP Lookup Shows the Wrong City? What to Check',
  'two-factor-authentication-setup-backup-codes-recovery': 'Two-Factor Authentication: Setup and Recovery',
  'paid-but-no-bandwidth-payment-not-showing': 'Paid but No Bandwidth? Fix a Missing Payment',
  'auto-allocate-and-auto-recharge-never-run-dry': 'Auto-Allocate and Auto-Recharge Explained',
  'sticky-sessions-keep-same-ip': 'Sticky Sessions: Keep the Same IP, Step by Step',
  'pause-resume-delete-session-bandwidth': 'Pause, Resume or Delete a Session Safely',
  'retarget-session-or-get-bandwidth-back': 'Wrong Location? Retarget or Get Your GB Back',
  'how-to-connect-to-globproxy-proxy': 'How to Connect to Your Proxy: Step-by-Step Setup',
  // blog
  'non-expiring-proxy-bandwidth': 'Why Residential Proxy Bandwidth Keeps Expiring',
  'city-level-proxy-targeting-explained': 'City-Level Proxy Targeting: When You Need It',
  'rotating-vs-sticky-sessions': 'Rotating vs. Sticky Proxy Sessions Explained',
  'ad-verification-geo-targeted-proxies': 'Verify Geo-Targeted Ads in Every City',
  'local-seo-rank-tracking-proxies': 'Local Rank Tracking Without Getting Flagged',
  'social-media-management-proxies': 'Multiple Social Accounts: The Proxy Layer',
  'iproyal-alternative-non-expiring-bandwidth': 'IPRoyal Alternative: Non-Expiring Bandwidth Math',
  'dataimpulse-alternative': 'DataImpulse Alternative: Beyond Per-GB Price',
  'proxy-pool-size-explained': 'Proxy Pool Size: What the Number Really Means',
  'proxy-pricing-real-cost-per-gb': 'Real Cost Per GB: Subscription vs Pay-Once',
  'how-white-label-proxy-reselling-works': 'How White-Label Proxy Reselling Works',
  'reseller-api-automating-sub-user-provisioning': 'Automate Sub-User Provisioning via API',
  'reseller-auto-topup-client-bandwidth': 'Auto-Topup So Client Bandwidth Never Runs Out',
  'ip-whitelisting-client-proxy-credentials': 'IP Whitelisting for Client Proxy Credentials',
  'pricing-your-white-label-proxy-service': 'Pricing Your White-Label Proxy Service',
}

/** The <title> for a post or help article: its SEO title (falling back to the headline) + brand. */
export function seoTitle(post: { slug: string; title: string }): string {
  return `${SEO_TITLES[post.slug] ?? post.title}${SEO_TITLE_SUFFIX}`
}
