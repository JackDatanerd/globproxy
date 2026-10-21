// Generated from upstream-targeting.json — regenerate by re-running
// scripts/generate-locations.py from the gp/ directory if the underlying
// network data changes. asnCount / stateCount / cityCount and majorCities are
// real figures pulled from that dataset, not placeholders — this is what
// backs the per-country pages' claims.

export interface LocationCountry {
  code: string
  name: string
  asnCount: number
  stateCount: number
  cityCount: number
  majorCities: string[]
}

export const LOCATION_COUNTRIES: LocationCountry[] = [
  { code: "us", name: "United States", asnCount: 1268, stateCount: 52, cityCount: 6562, majorCities: ["New York", "Los Angeles", "Chicago", "Miami", "Dallas", "Seattle"] },
  { code: "gb", name: "United Kingdom", asnCount: 158, stateCount: 4, cityCount: 1236, majorCities: ["London", "Manchester", "Birmingham", "Glasgow", "Leeds", "Bristol"] },
  { code: "ca", name: "Canada", asnCount: 186, stateCount: 13, cityCount: 868, majorCities: ["Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa", "Edmonton"] },
  { code: "de", name: "Germany", asnCount: 186, stateCount: 17, cityCount: 912, majorCities: ["Berlin", "Munich", "Frankfurt", "Hamburg", "Cologne", "Stuttgart"] },
  { code: "fr", name: "France", asnCount: 75, stateCount: 13, cityCount: 2226, majorCities: ["Paris", "Marseille", "Lyon", "Toulouse", "Nice", "Bordeaux"] },
  { code: "nl", name: "Netherlands", asnCount: 108, stateCount: 14, cityCount: 282, majorCities: ["Amsterdam", "Rotterdam", "The Hague", "Utrecht", "Eindhoven"] },
  { code: "au", name: "Australia", asnCount: 76, stateCount: 8, cityCount: 81, majorCities: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide"] },
  { code: "jp", name: "Japan", asnCount: 121, stateCount: 44, cityCount: 317, majorCities: ["Tokyo", "Osaka", "Yokohama", "Nagoya", "Sapporo"] },
  { code: "br", name: "Brazil", asnCount: 2916, stateCount: 27, cityCount: 1623, majorCities: ["São Paulo", "Rio de Janeiro", "Brasiléia", "Salvador", "Fortaleza"] },
  { code: "in", name: "India", asnCount: 519, stateCount: 35, cityCount: 466, majorCities: ["Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Chennai", "Kolkata"] },
  { code: "za", name: "South Africa", asnCount: 146, stateCount: 9, cityCount: 188, majorCities: ["Johannesburg", "Cape Town", "Durban", "Pretoria"] },
  { code: "ng", name: "Nigeria", asnCount: 42, stateCount: 8, cityCount: 18, majorCities: ["Lagos", "Abuja", "Ibadan", "Port Harcourt"] },
  { code: "ae", name: "United Arab Emirates", asnCount: 6, stateCount: 7, cityCount: 13, majorCities: ["Dubai", "Abu Dhabi", "Sharjah"] },
  { code: "sg", name: "Singapore", asnCount: 53, stateCount: 5, cityCount: 5, majorCities: ["Singapore"] },
  { code: "es", name: "Spain", asnCount: 240, stateCount: 19, cityCount: 1177, majorCities: ["Madrid", "Barcelona", "Valencia", "Seville", "Málaga"] },
  { code: "it", name: "Italy", asnCount: 170, stateCount: 20, cityCount: 1093, majorCities: ["Rome", "Milan", "Naples", "Turin", "Florence"] },
  { code: "mx", name: "Mexico", asnCount: 160, stateCount: 32, cityCount: 467, majorCities: ["Mexico City", "Guadalajara", "Monterrey", "Puebla"] },
  { code: "id", name: "Indonesia", asnCount: 567, stateCount: 36, cityCount: 484, majorCities: ["Jakarta", "Surabaya", "Bandung", "Medan"] },
  { code: "pl", name: "Poland", asnCount: 347, stateCount: 17, cityCount: 459, majorCities: ["Warsaw", "Krakow", "Lodz", "Wroclaw", "Poznan"] },
  { code: "se", name: "Sweden", asnCount: 40, stateCount: 22, cityCount: 137, majorCities: ["Stockholm", "Gothenburg", "Malmö"] },
  { code: "ch", name: "Switzerland", asnCount: 32, stateCount: 22, cityCount: 138, majorCities: ["Zurich", "Geneva", "Basel", "Bern"] },
  { code: "ie", name: "Ireland", asnCount: 39, stateCount: 4, cityCount: 222, majorCities: ["Dublin", "Cork", "Galway"] },
  { code: "be", name: "Belgium", asnCount: 17, stateCount: 3, cityCount: 152, majorCities: ["Brussels", "Antwerp", "Ghent"] },
  { code: "pt", name: "Portugal", asnCount: 24, stateCount: 20, cityCount: 373, majorCities: ["Lisbon", "Porto", "Braga"] },
  { code: "ke", name: "Kenya", asnCount: 57, stateCount: 16, cityCount: 23, majorCities: ["Nairobi", "Mombasa", "Kisumu"] },
  { code: "eg", name: "Egypt", asnCount: 8, stateCount: 22, cityCount: 53, majorCities: ["Cairo", "Alexandria", "Giza"] },
  { code: "ph", name: "Philippines", asnCount: 129, stateCount: 18, cityCount: 257, majorCities: ["Manila", "Quezon City", "Davao City", "Cebu City"] },
  { code: "th", name: "Thailand", asnCount: 58, stateCount: 69, cityCount: 195, majorCities: ["Bangkok", "Chiang Mai", "Pattaya"] },
]
