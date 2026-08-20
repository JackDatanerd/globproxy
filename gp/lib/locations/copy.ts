import type { LocationCountry } from './data'

// A handful of structurally different openings, rotated by index rather than
// repeated verbatim with only the country name swapped — the actual
// differentiator between pages is the real per-country data (ASN count,
// city count, verified major cities), but varying the sentence structure
// too avoids the page reading as one template with find-and-replace.
const INTRO_TEMPLATES: ((c: LocationCountry) => string)[] = [
  (c) =>
    `Residential proxy coverage for ${c.name} spans ${c.asnCount.toLocaleString()} distinct network${c.asnCount === 1 ? '' : 's'} across ${c.stateCount} region${c.stateCount === 1 ? '' : 's'}, with city-level selection available in ${c.cityCount.toLocaleString()} location${c.cityCount === 1 ? '' : 's'} nationwide.`,
  (c) =>
    `${c.name} is one of GlobProxy's supported markets: ${c.cityCount.toLocaleString()} cities across ${c.stateCount} region${c.stateCount === 1 ? '' : 's'}, backed by ${c.asnCount.toLocaleString()} carrier network${c.asnCount === 1 ? '' : 's'} of real residential IPs — not a single blanket "country" IP standing in for the whole territory.`,
  (c) =>
    `For tasks that need a genuine ${c.name} IP — not an approximation — GlobProxy's network covers ${c.stateCount} region${c.stateCount === 1 ? '' : 's'} and ${c.cityCount.toLocaleString()} cities in-country, drawing from ${c.asnCount.toLocaleString()} distinct residential network${c.asnCount === 1 ? '' : 's'}.`,
]

export function locationIntro(country: LocationCountry): string {
  const i = country.code.charCodeAt(0) % INTRO_TEMPLATES.length
  return INTRO_TEMPLATES[i](country)
}

const USE_CASE_ANGLES: { title: string; text: (c: LocationCountry) => string }[] = [
  {
    title: 'Local SEO & SERP tracking',
    text: (c) =>
      `Track how ${c.name}'s local search results actually look from inside the market — city-level targeting means rank-checking from where the searcher is, not from a country-wide approximation.`,
  },
  {
    title: 'Ad verification',
    text: (c) =>
      `Confirm geo-targeted campaigns are actually serving the right creative and pricing to ${c.name} audiences, city by city, rather than trusting the ad platform's own delivery reporting alone.`,
  },
  {
    title: 'Account & session management',
    text: (c) =>
      `Sticky sessions held on a consistent ${c.name} city-level IP for account management workflows that need believable, stable location signals.`,
  },
  {
    title: 'Market & price research',
    text: (c) =>
      `Check pricing, inventory, and localized content the way a real visitor in ${c.name} would see it — useful wherever what's shown depends on where the request comes from.`,
  },
]

export function locationUseCases() {
  return USE_CASE_ANGLES
}
