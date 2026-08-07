"""
Inlines src/draft_core.js, config/league.json, and data/bundle.json into
app/board_template.html, producing app/draftboard.html: one self-contained
file that runs from disk in any browser.

Rerun after any bundle rebuild.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def safe_json(obj) -> str:
    """Serialize for embedding in a <script> block: '</' would close the tag."""
    return json.dumps(obj, separators=(",", ":")).replace("</", "<\\/")


def main():
    template = (ROOT / "app" / "board_template.html").read_text()
    core = (ROOT / "src" / "draft_core.js").read_text()
    dist = (ROOT / "src" / "distributions.js").read_text()
    intel = (ROOT / "src" / "intel.js").read_text()
    scoring = (ROOT / "src" / "scoring.js").read_text()
    sim = (ROOT / "src" / "sim.js").read_text()
    recommend = (ROOT / "src" / "recommend.js").read_text()
    league = json.loads((ROOT / "config" / "league.json").read_text())
    bundle = json.loads((ROOT / "data" / "bundle.json").read_text())
    prof_path = ROOT / "data" / "league" / "manager_profiles.json"
    profiles = json.loads(prof_path.read_text()) if prof_path.exists() else {"managers": {}, "earliest_K": 7}

    out = (template
           .replace("__DRAFT_CORE__", core)
           .replace("__DISTRIBUTIONS__", dist)
           .replace("__INTEL__", intel)
           .replace("__SCORING__", scoring)
           .replace("__SIM__", sim)
           .replace("__RECOMMEND__", recommend)
           .replace("__LEAGUE_JSON__", safe_json(league))
           .replace("__BUNDLE_JSON__", safe_json(bundle))
           .replace("__PROFILES_JSON__", safe_json(profiles)))

    for ph in ("__DRAFT_CORE__", "__DISTRIBUTIONS__", "__INTEL__", "__SCORING__", "__SIM__", "__RECOMMEND__", "__LEAGUE_JSON__", "__BUNDLE_JSON__", "__PROFILES_JSON__"):
        assert ph not in out, f"placeholder {ph} not replaced"

    dest = ROOT / "app" / "draftboard.html"
    dest.write_text(out)
    print(f"[board] wrote {dest.name} ({len(out)/1e6:.2f} MB, fully offline)")


if __name__ == "__main__":
    main()
