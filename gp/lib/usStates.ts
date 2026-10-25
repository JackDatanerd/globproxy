// Used to render a proper dropdown for US state targeting instead of free
// text — state names must match upstream's expected format exactly (lowercase,
// no spaces) once passed through slug() in lib/proxyEndpoint.ts, so a
// dropdown avoids typos/format mismatches customers would otherwise hit.
export interface StateOption {
  value: string   // matches upstream's expected slug once lowercased/stripped
  label: string
  popular?: boolean
}

export const US_STATES: StateOption[] = [
  { value: 'california',     label: 'California',     popular: true },
  { value: 'new york',       label: 'New York',        popular: true },
  { value: 'texas',          label: 'Texas',           popular: true },
  { value: 'florida',        label: 'Florida',         popular: true },
  { value: 'illinois',       label: 'Illinois',        popular: true },
  { value: 'washington',     label: 'Washington',      popular: true },
  { value: 'georgia',        label: 'Georgia',         popular: true },
  { value: 'virginia',       label: 'Virginia',        popular: true },

  { value: 'alabama',        label: 'Alabama' },
  { value: 'alaska',         label: 'Alaska' },
  { value: 'arizona',        label: 'Arizona' },
  { value: 'arkansas',       label: 'Arkansas' },
  { value: 'colorado',       label: 'Colorado' },
  { value: 'connecticut',    label: 'Connecticut' },
  { value: 'delaware',       label: 'Delaware' },
  { value: 'hawaii',         label: 'Hawaii' },
  { value: 'idaho',          label: 'Idaho' },
  { value: 'indiana',        label: 'Indiana' },
  { value: 'iowa',           label: 'Iowa' },
  { value: 'kansas',         label: 'Kansas' },
  { value: 'kentucky',       label: 'Kentucky' },
  { value: 'louisiana',      label: 'Louisiana' },
  { value: 'maine',          label: 'Maine' },
  { value: 'maryland',       label: 'Maryland' },
  { value: 'massachusetts',  label: 'Massachusetts' },
  { value: 'michigan',       label: 'Michigan' },
  { value: 'minnesota',      label: 'Minnesota' },
  { value: 'mississippi',    label: 'Mississippi' },
  { value: 'missouri',       label: 'Missouri' },
  { value: 'montana',        label: 'Montana' },
  { value: 'nebraska',       label: 'Nebraska' },
  { value: 'nevada',         label: 'Nevada' },
  { value: 'new hampshire',  label: 'New Hampshire' },
  { value: 'new jersey',     label: 'New Jersey' },
  { value: 'new mexico',     label: 'New Mexico' },
  { value: 'north carolina', label: 'North Carolina' },
  { value: 'north dakota',   label: 'North Dakota' },
  { value: 'ohio',           label: 'Ohio' },
  { value: 'oklahoma',       label: 'Oklahoma' },
  { value: 'oregon',         label: 'Oregon' },
  { value: 'pennsylvania',   label: 'Pennsylvania' },
  { value: 'rhode island',   label: 'Rhode Island' },
  { value: 'south carolina', label: 'South Carolina' },
  { value: 'south dakota',   label: 'South Dakota' },
  { value: 'tennessee',      label: 'Tennessee' },
  { value: 'utah',           label: 'Utah' },
  { value: 'vermont',        label: 'Vermont' },
  { value: 'west virginia',  label: 'West Virginia' },
  { value: 'wisconsin',      label: 'Wisconsin' },
  { value: 'wyoming',        label: 'Wyoming' },
]

export const POPULAR_US_STATES = US_STATES.filter(s => s.popular)
export const OTHER_US_STATES = US_STATES.filter(s => !s.popular)
