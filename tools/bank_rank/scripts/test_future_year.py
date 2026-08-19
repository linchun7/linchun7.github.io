#!/usr/bin/env python3
"""Smoke-test validator behavior for a future annual block."""
from __future__ import annotations
import copy, importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location("validate_data", ROOT/"scripts"/"validate_data.py"); MODULE=importlib.util.module_from_spec(SPEC); assert SPEC.loader is not None; SPEC.loader.exec_module(MODULE)

def main() -> int:
    data=MODULE.load_rankings(); snapshot=MODULE.load_snapshot(); next_data=copy.deepcopy(data["years"][-1]); new_year=next_data["rankingYear"]+1
    next_data.update({"rankingYear":new_year,"dataYear":new_year-1,"publishedAt":f"{new_year}-08-01","officialUrl":"https://www.china-cba.net/","transcriptionUrl":"https://www.china-cba.net/"}); next_data.pop("officialSummary",None)
    data["years"].append(next_data); data["scope"]["maxRankingYear"]=new_year
    snapshot["years"].append({"rankingYear":new_year,"dataYear":new_year-1,"publishedAt":next_data["publishedAt"],"officialUrl":next_data["officialUrl"],"transcriptionUrl":next_data["transcriptionUrl"],"recordCount":len(next_data["records"]),"normalizedRecordsSha256":MODULE.records_digest(next_data["records"]),"normalizations":[]})
    errors=MODULE.validate_dataset(data,snapshot)
    if errors:
        print("future-year smoke test FAILED"); [print(f"- {e}") for e in errors]; return 1
    broken=copy.deepcopy(data); broken_snapshot=copy.deepcopy(snapshot)
    broken["years"][-1]["records"][1]["bankId"]=broken["years"][-1]["records"][0]["bankId"]
    broken_snapshot["years"][-1]["normalizedRecordsSha256"]=MODULE.records_digest(broken["years"][-1]["records"])
    broken_errors=MODULE.validate_dataset(broken,broken_snapshot)
    if not any("duplicate bankId within year" in error for error in broken_errors):
        print("future-year negative test FAILED: duplicate entity was not rejected specifically"); [print(f"- {e}") for e in broken_errors]; return 1
    print(f"future-year smoke test OK: synthetic {new_year} accepted; duplicate entity rejected")
    return 0
if __name__ == "__main__": raise SystemExit(main())
