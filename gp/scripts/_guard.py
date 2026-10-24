# Shared guards for the generate-*.py scripts (imported as `import _guard`; Python puts
# the script's own directory first on sys.path, so this works when they are run as
# `python3 scripts/generate-….py` from gp/).
#
# They all read the git-ignored upstream-targeting.json and write into the repo using
# RELATIVE paths. Run from the wrong directory they used to either crash with a bare
# traceback or — worse — write public/geo/ and lib/ files into whatever directory the
# shell happened to be in; a half-pulled or error-body source file was only caught by
# some of them. One place for the checks, so none of them can be skipped by one script.
import json
import os
import sys


def require_gp_dir() -> None:
    if not (os.path.isfile("package.json") and os.path.isdir("lib") and os.path.isdir("public")):
        sys.exit(f"Run this from the gp/ directory (current directory: {os.getcwd()}), e.g.  python3 scripts/<script>.py")


def load_source(path: str) -> dict:
    require_gp_dir()
    if not os.path.isfile(path):
        sys.exit(f"{path} not found in {os.getcwd()}. Pull it first:  npm run pull:targeting")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        sys.exit(f"{path} is not valid JSON ({e}). A failed or truncated download looks like this — pull it again.")
    countries = data.get("countries") if isinstance(data, dict) else None
    if not isinstance(countries, list) or not countries:
        sys.exit(f"{path} has no 'countries' list — it is probably an error response, not the targeting export. Pull it again.")
    return data


def write_text_atomic(path: str, text: str) -> None:
    # Write next to the target, then rename: an interrupted run never leaves a
    # half-written data file that the app (or the next build) would read.
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)
