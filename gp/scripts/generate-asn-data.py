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

import json, os, sys

import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _guard  # noqa: E402

SRC = "upstream-targeting.json"
OUT_DIR = "public/geo/asns"
INDEX_OUT = "lib/geo/asnIndex.json"

countries = _guard.load_source(SRC)["countries"]

# Same shape check generate-geo-data.py does: refuse to publish a collapse against what is
# already live (a truncated export would otherwise delete most countries' ISP lists).
_prev_index = None
if os.path.exists(INDEX_OUT):
    try:
        with open(INDEX_OUT, encoding="utf-8") as _f:
            _prev_index = json.load(_f)
    except (json.JSONDecodeError, OSError):
        _prev_index = None

# Build everything in memory first, check it, and only then touch the published files: the
# refusal below used to run AFTER the per-country files had been rewritten, so a truncated
# export overwrote them even though the script then said nothing had been changed.
index = {}
by_country = {}
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
    by_country[cc] = rows
    index[cc] = sorted((r["code"] for r in rows), key=int)
    total += len(rows)

if _prev_index and len(index) < len(_prev_index) * 0.8:
    sys.exit(f"REFUSING: only {len(index)} countries have ASNs but {len(_prev_index)} are published (a >20% drop looks like a truncated export). Re-pull upstream-targeting.json. Nothing was written or removed.")

os.makedirs(OUT_DIR, exist_ok=True)
for cc, rows in by_country.items():
    _guard.write_text_atomic(os.path.join(OUT_DIR, f"{cc}.json"), json.dumps(rows, ensure_ascii=False, separators=(",", ":")))

# A country that has lost all its ASNs is skipped above, which used to leave its old
# file published (and offered in the ISP picker) while the server-side index no longer
# knew the country. Remove files that are not part of this run.
_keep = {f"{cc}.json" for cc in index}
for _name in os.listdir(OUT_DIR):
    if _name.endswith(".json") and _name not in _keep:
        os.remove(os.path.join(OUT_DIR, _name))
        print("Removed stale", os.path.join(OUT_DIR, _name))

_guard.write_text_atomic(INDEX_OUT, json.dumps(index, separators=(",", ":")))

print(f"wrote {len(index)} country ASN files, {total} ASNs")
