// The help centre (/help): customer how-to articles, grouped by topic.
//
// The articles themselves live in posts.ts with `section: 'help'`; this file only
// decides how /help groups and orders them. A test (tests/help-section.test.mjs)
// fails if a help article is missing from here or listed twice, so a new one
// cannot silently go unlisted on the hub.
export interface HelpTopic {
  title: string
  blurb: string
  slugs: string[]
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    title: 'Getting started',
    blurb: 'Connect to the proxy and make your first request.',
    slugs: ['how-to-connect-to-globproxy-proxy'],
  },
  {
    title: 'Sessions and targeting',
    blurb: 'Change the country or city, keep the same IP, and manage your sessions.',
    slugs: [
      'retarget-session-or-get-bandwidth-back',
      'sticky-sessions-keep-same-ip',
      'pause-resume-delete-session-bandwidth',
      'ip-lookup-shows-wrong-city-proxy-location',
    ],
  },
  {
    title: 'Bandwidth and payments',
    blurb: 'Where your GB went, automatic top-ups, and payments that have not shown up.',
    slugs: [
      'usage-and-remaining-gb-not-matching',
      'request-a-refund-eligibility-and-timeline',
      'auto-allocate-and-auto-recharge-never-run-dry',
      'paid-but-no-bandwidth-payment-not-showing',
    ],
  },
  {
    title: 'Account security',
    blurb: 'Two-factor sign-in, backup codes and getting back into your account.',
    slugs: ['two-factor-authentication-setup-backup-codes-recovery'],
  },
]
