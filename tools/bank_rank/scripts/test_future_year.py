#!/usr/bin/env python3
"""Smoke-test that the validator accepts a future annual block without code edits."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "validate_data", ROOT / "scripts" / "validate_data.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def main() -> int:
    data = json.loads((ROOT / "data" / "rankings.json").read_text(encoding="utf-8"))
    snapshot = json.loads(
        (ROOT / "data" / "source-snapshot.json").read_text(encoding="utf-8")
    )

    next_data = copy.deepcopy(data["years"][-1])
    next_snapshot = copy.deepcopy(snapshot["years"][-1])
    new_year = next_data["rankingYear"] + 1

    next_data["rankingYear"] = new_year
    next_data["dataYear"] = new_year - 1
    next_data["publishedAt"] = f"{new_year}-08-01"
    next_data["officialUrl"] = "https://www.china-cba.net/"
    next_data.pop("officialSummary", None)

    next_snapshot["rankingYear"] = new_year
    next_snapshot["dataYear"] = new_year - 1
    next_snapshot["publishedAt"] = f"{new_year}-08-01"
    next_snapshot["officialUrl"] = "https://www.china-cba.net/"

    data["years"].append(next_data)
    snapshot["years"].append(next_snapshot)

    errors = MODULE.validate_dataset(data, snapshot)
    if errors:
        print("future-year smoke test FAILED")
        for error in errors:
            print(f"- {error}")
        return 1

    broken = copy.deepcopy(data)
    broken["years"][-1]["records"][1]["bankId"] = broken["years"][-1]["records"][0]["bankId"]
    if not MODULE.validate_dataset(broken, snapshot):
        print("future-year negative test FAILED: duplicate entity was not rejected")
        return 1

    print(f"future-year smoke test OK: synthetic {new_year} accepted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
