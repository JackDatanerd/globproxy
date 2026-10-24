# Regenerates lib/locations/data.ts — the real (not fabricated) per-country
# stats (ASN/carrier-network count, state count, city count) and a
# hand-curated, JSON-verified list of major cities per country, used by the
# /locations marketing pages.
#
# Curation lives in CURATED below: add a country code and a wishlist of
# major-city names, and the script verifies each candidate actually exists
# in the source data before including it (misspelled or unsupported cities
# are dropped and printed, not silently included) — this is what keeps the
# location pages honest instead of just templated with placeholder claims.
#
# Run from the gp/ directory whenever upstream-targeting.json is
# refreshed:
#
#   python3 scripts/generate-locations.py

import json
import re
import sys

import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _guard  # noqa: E402

SRC = "upstream-targeting.json"
OUT = "lib/locations/data.ts"

CURATED = {
    "us": ["New York", "Los Angeles", "Chicago", "Miami", "Dallas", "Seattle"],
    "gb": ["London", "Manchester", "Birmingham", "Glasgow", "Leeds", "Bristol"],
    "ca": ["Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa", "Edmonton"],
    "de": ["Berlin", "Munich", "Frankfurt", "Hamburg", "Cologne", "Stuttgart"],
    "fr": ["Paris", "Marseille", "Lyon", "Toulouse", "Nice", "Bordeaux"],
    "nl": ["Amsterdam", "Rotterdam", "The Hague", "Utrecht", "Eindhoven"],
    "au": ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide"],
    "jp": ["Tokyo", "Osaka", "Yokohama", "Nagoya", "Sapporo"],
    "br": ["São Paulo", "Rio De Janeiro", "Brasilia", "Salvador", "Fortaleza"],
    "in": ["Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Chennai", "Kolkata"],
    "za": ["Johannesburg", "Cape Town", "Durban", "Pretoria"],
    "ng": ["Lagos", "Abuja", "Ibadan", "Port Harcourt"],
    "ae": ["Dubai", "Abu Dhabi", "Sharjah"],
    "sg": ["Singapore"],
    "es": ["Madrid", "Barcelona", "Valencia", "Seville", "Málaga"],
    "it": ["Rome", "Milan", "Naples", "Turin", "Florence"],
    "mx": ["Mexico City", "Guadalajara", "Monterrey", "Puebla"],
    "id": ["Jakarta", "Surabaya", "Bandung", "Medan"],
    "pl": ["Warsaw", "Krakow", "Lodz", "Wroclaw", "Poznan"],
    "se": ["Stockholm", "Gothenburg", "Malmö"],
    "ch": ["Zurich", "Geneva", "Basel", "Bern"],
    "ie": ["Dublin", "Cork", "Galway"],
    "be": ["Brussels", "Antwerp", "Ghent"],
    "pt": ["Lisbon", "Porto", "Braga"],
    "ke": ["Nairobi", "Mombasa", "Kisumu"],
    "eg": ["Cairo", "Alexandria", "Giza"],
    "ph": ["Manila", "Quezon City", "Davao City", "Cebu City"],
    "th": ["Bangkok", "Chiang Mai", "Pattaya"],
}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def main():
    source = _guard.load_source(SRC)
    countries_by_code = {c["code"]: c for c in source["countries"]}

    results = []
    missing = []
    for code, candidates in CURATED.items():
        country = countries_by_code.get(code)
        if not country:
            print(f"MISSING COUNTRY in source data: {code}")
            missing.append(code)
            continue

        all_cities = {}
        for state in country.get("states", []):
            for city in state.get("cities", []):
                all_cities[norm(city["name"])] = city["name"]

        verified = []
        for candidate in candidates:
            match = all_cities.get(norm(candidate))
            if match:
                verified.append(match)
            else:
                print(f"  dropping unverified city for {code}: {candidate!r}")

        if not verified:
            sys.exit(f"REFUSING: none of the curated cities for {code} exist in the source data — the export looks wrong. Nothing was written.")
        total_cities = sum(len(s.get("cities", [])) for s in country.get("states", []))
        results.append(
            {
                "code": code,
                "name": country["name"],
                # Same rule as generate-asn-data.py (numeric codes, de-duplicated) so the
                # figure on a /locations page equals what the ISP picker really offers.
                # .get(): a country with no "asns" key used to crash the whole run.
                "asnCount": len({str(a.get("code", "")).strip() for a in country.get("asns", []) if str(a.get("code", "")).strip().isdigit()}),
                "stateCount": len(country.get("states", [])),
                "cityCount": total_cities,
                "majorCities": verified,
            }
        )

    # A curated country that vanished from the source used to be skipped with one printed
    # line, silently deleting its /locations page (and sitemap entry) on the next build.
    if missing and "--allow-missing" not in sys.argv:
        sys.exit(f"REFUSING: {len(missing)} curated country code(s) are not in the source data: {', '.join(missing)}. "
                 "Fix CURATED or re-pull the source; pass --allow-missing to drop them on purpose.")

    lines = [
        "// Generated from upstream-targeting.json — regenerate by re-running",
        "// scripts/generate-locations.py from the gp/ directory if the underlying",
        "// network data changes. asnCount / stateCount / cityCount and majorCities are",
        "// real figures pulled from that dataset, not placeholders — this is what",
        "// backs the per-country pages' claims.",
        "",
        "export interface LocationCountry {",
        "  code: string",
        "  name: string",
        "  asnCount: number",
        "  stateCount: number",
        "  cityCount: number",
        "  majorCities: string[]",
        "}",
        "",
        "export const LOCATION_COUNTRIES: LocationCountry[] = [",
    ]
    for r in results:
        cities = ", ".join(json.dumps(c, ensure_ascii=False) for c in r["majorCities"])
        lines.append(
            "  { code: %s, name: %s, asnCount: %d, stateCount: %d, cityCount: %d, majorCities: [%s] },"
            % (
                json.dumps(r["code"]),
                json.dumps(r["name"], ensure_ascii=False),
                r["asnCount"],
                r["stateCount"],
                r["cityCount"],
                cities,
            )
        )
    lines.append("]")
    lines.append("")

    _guard.write_text_atomic(OUT, "\n".join(lines))

    print(f"\nWrote {OUT} — {len(results)} countries.")


if __name__ == "__main__":
    main()
