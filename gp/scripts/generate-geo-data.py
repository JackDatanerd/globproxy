# Regenerates public/geo/ (the static data behind the country/state/city
# picker on the New Proxy Session form) from Geonode's real targeting-options
# response.
#
# Run from the gp/ directory whenever geonode-residential-premium.json is
# refreshed (Geonode's location/ISP inventory does drift over time — see the
# diffs Claude found between two earlier snapshot exports):
#
#   python3 scripts/generate-geo-data.py
#
# Re-pull the source file first with:
#   curl -X GET "https://monitor.geonode.com/services/RESIDENTIAL-PREMIUM/targeting-options" \
#     -u <upstream_username>:<password> -o "geonode-residential-premium.json"

import json, os, re, sys

SRC = "geonode-residential-premium.json"
OUT_ROOT = "public/geo"

with open(SRC, "r", encoding="utf-8") as f:
    raw = json.load(f)

countries = raw["countries"]

# ---- sanity re-checks before writing anything (cheap insurance) ----
assert len(countries) == 210, f"expected 210 countries, got {len(countries)}"
codes = [c["code"] for c in countries]
assert len(codes) == len(set(codes)), "duplicate country codes!"
for c in countries:
    assert c.get("code") and c.get("name"), f"missing code/name: {c}"
    scodes = [s["code"] for s in c.get("states", [])]
    assert len(scodes) == len(set(scodes)), f"duplicate state codes in {c['code']}"
    for s in c.get("states", []):
        ccodes = [ci["code"] for ci in s.get("cities", [])]
        assert len(ccodes) == len(set(ccodes)), f"duplicate city codes in {c['code']}/{s['code']}"

# Geonode's own codes are already lowercase/no-space slugs — verify that
# assumption instead of trusting it, since buildProxyUsername's slug()
# depends on these values needing no further transformation.
slug_re = re.compile(r'^[a-z0-9]+$')
bad = []
for c in countries:
    if not slug_re.match(c["code"]):
        bad.append(("country", c["code"]))
    for s in c.get("states", []):
        if not slug_re.match(s["code"]):
            bad.append(("state", f"{c['code']}/{s['code']}"))
        for ci in s.get("cities", []):
            if not slug_re.match(ci["code"]):
                bad.append(("city", f"{c['code']}/{s['code']}/{ci['code']}"))
if bad:
    print(f"WARNING: {len(bad)} codes don't match the plain lowercase-alnum slug pattern:")
    for kind, val in bad[:30]:
        print(" ", kind, val)
    if len(bad) > 30:
        print(f"  ...and {len(bad)-30} more")

# ---- write countries.json (list for the top-level dropdown) ----
os.makedirs(OUT_ROOT, exist_ok=True)
country_list = sorted(
    [{"code": c["code"], "name": c["name"], "stateCount": len(c.get("states", []))} for c in countries],
    key=lambda x: x["name"]
)
with open(os.path.join(OUT_ROOT, "countries.json"), "w", encoding="utf-8") as f:
    json.dump(country_list, f, ensure_ascii=False, separators=(",", ":"))

# ---- write one slim states+cities file per country (no ASNs) ----
os.makedirs(os.path.join(OUT_ROOT, "countries"), exist_ok=True)
for c in countries:
    slim = {
        "code": c["code"],
        "name": c["name"],
        "states": [
            {
                "code": s["code"],
                "name": s["name"],
                "cities": [{"code": ci["code"], "name": ci["name"]} for ci in s.get("cities", [])],
            }
            for s in c.get("states", [])
        ],
    }
    with open(os.path.join(OUT_ROOT, "countries", f"{c['code']}.json"), "w", encoding="utf-8") as f:
        json.dump(slim, f, ensure_ascii=False, separators=(",", ":"))

print("Wrote", os.path.join(OUT_ROOT, "countries.json"))
print("Wrote", len(countries), "per-country files under", os.path.join(OUT_ROOT, "countries"))

# ---- final self-check: re-read everything back and diff counts against source ----
with open(os.path.join(OUT_ROOT, "countries.json"), encoding="utf-8") as f:
    check_list = json.load(f)
assert len(check_list) == 210

total_states_src = sum(len(c.get("states", [])) for c in countries)
total_cities_src = sum(len(s.get("cities", [])) for c in countries for s in c.get("states", []))
total_states_out = 0
total_cities_out = 0
for c in countries:
    with open(os.path.join(OUT_ROOT, "countries", f"{c['code']}.json"), encoding="utf-8") as f:
        d = json.load(f)
    total_states_out += len(d["states"])
    total_cities_out += sum(len(s["cities"]) for s in d["states"])

assert total_states_out == total_states_src, (total_states_out, total_states_src)
assert total_cities_out == total_cities_src, (total_cities_out, total_cities_src)
print(f"Verified: {total_states_out} states, {total_cities_out} cities written == source counts")
