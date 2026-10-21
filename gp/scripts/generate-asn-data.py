# Regenerates the ISP/ASN targeting data from upstream-targeting.json (the same
# git-ignored source file scripts/generate-geo-data.py reads — re-pull it first,
# see that script's header). Writes two things:
#
#   public/geo/asns/<cc>.json   [{ "code": "7922", "name": "AS7922 COMCAST…" }]
#       fetched by the New Proxy / Edit forms to offer an ISP picker per country
#   lib/geo/asnIndex.json       { "us": ["3", "12", …] }
#       bundled server-side so the API can reject an ASN that doesn't exist in
#       the chosen country (lib/apiValidation.ts) instead of silently creating
#       a session that can never find a peer
#
# Run from the gp/ directory:   python3 scripts/generate-asn-data.py

import json, os

SRC = "upstream-targeting.json"
OUT_DIR = "public/geo/asns"
INDEX_OUT = "lib/geo/asnIndex.json"

with open(SRC, "r", encoding="utf-8") as f:
    countries = json.load(f)["countries"]

os.makedirs(OUT_DIR, exist_ok=True)
index = {}
total = 0
for c in countries:
    cc = c["code"]
    seen = set()
    rows = []
    for a in c.get("asns", []):
        code = str(a.get("code", "")).strip()
        if not code.isdigit() or code in seen:
            continue
        seen.add(code)
        rows.append({"code": code, "name": str(a.get("name") or f"AS{code}").strip()})
    if not rows:
        continue
    rows.sort(key=lambda r: r["name"].lower())
    with open(os.path.join(OUT_DIR, f"{cc}.json"), "w", encoding="utf-8") as out:
        json.dump(rows, out, ensure_ascii=False, separators=(",", ":"))
    index[cc] = sorted((r["code"] for r in rows), key=int)
    total += len(rows)

with open(INDEX_OUT, "w", encoding="utf-8") as out:
    json.dump(index, out, separators=(",", ":"))

print(f"wrote {len(index)} country ASN files, {total} ASNs")
