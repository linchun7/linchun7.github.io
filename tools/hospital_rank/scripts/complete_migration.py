#!/usr/bin/env python3
"""Complete legacy migration gaps by resolving source records to normalized hospital entities.

This is migration-only glue: it reads the structured source snapshot and the candidate
entity registry produced by build_data.py, then fills source years that were absent from
the legacy data set (notably 2011) by exact/strong-fuzzy matching against canonical names
and accumulated aliases. It never guesses a hospital when the match is ambiguous.
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


def norm(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    return re.sub(r"[\s()（）\[\]【】{}·•,，。;；:：'\"“”‘’/\\\-—_]+", "", value).lower()


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def match_entity(source_name: str, hospitals: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, str, float]:
    token = norm(source_name)
    exact: list[dict[str, Any]] = []
    scored: list[tuple[float, dict[str, Any]]] = []

    for hospital in hospitals:
        names = [hospital.get("name", ""), *(hospital.get("aliases") or [])]
        normalized = {norm(name) for name in names if name}
        if token in normalized:
            exact.append(hospital)
            continue
        score = max((difflib.SequenceMatcher(None, token, candidate).ratio() for candidate in normalized), default=0.0)
        scored.append((score, hospital))

    if len(exact) == 1:
        return exact[0], "entity-exact", 1.0
    if len(exact) > 1:
        return None, "entity-exact-ambiguous", 1.0

    scored.sort(key=lambda item: item[0], reverse=True)
    if scored:
        best_score, best = scored[0]
        second_score = scored[1][0] if len(scored) > 1 else 0.0
        if best_score >= 0.92 and best_score - second_score >= 0.06:
            return best, "entity-fuzzy", best_score
        return None, "entity-unmatched", best_score
    return None, "entity-unmatched", 0.0


def normalized_record(source: dict[str, Any], hospital_id: str, mode: str) -> dict[str, Any]:
    row: dict[str, Any] = {
        "hospitalId": hospital_id,
        "sourceName": source["sourceName"],
    }
    if mode == "numeric":
        row.update({
            "rank": source["rank"],
            "grade": None,
            "specialtyReputation": source["specialtyReputation"],
            "researchAcademic": source["researchAcademic"],
            "overallScore": source["overallScore"],
        })
    else:
        row.update({
            "rank": None,
            "grade": source["grade"],
            "specialtyReputation": None,
            "researchAcademic": None,
            "overallScore": None,
        })
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir", type=Path, required=True)
    args = ap.parse_args()

    snapshot_path = args.output_dir / "source-snapshot.json"
    candidate_path = args.output_dir / "candidate-rankings.json"
    audit_path = args.output_dir / "audit.json"
    snapshot = load(snapshot_path)
    candidate = load(candidate_path)
    audit = load(audit_path)

    hospitals = candidate["hospitals"]
    source_by_year = {int(block["year"]): block for block in snapshot["years"]}
    candidate_by_year = {int(block["year"]): block for block in candidate["years"]}

    recovered: list[dict[str, Any]] = []
    remaining: list[dict[str, Any]] = []
    fuzzy: list[dict[str, Any]] = []

    for missing in audit.get("unmatchedSource", []):
        year = int(missing["year"])
        source_block = source_by_year[year]
        source = next(record for record in source_block["records"] if record["sourceName"] == missing["sourceName"])
        entity, method, score = match_entity(source["sourceName"], hospitals)
        if entity is None:
            remaining.append({**missing, "entityBestScore": round(score, 4), "entityMethod": method})
            continue

        candidate_block = candidate_by_year[year]
        if any(record["hospitalId"] == entity["id"] for record in candidate_block["records"]):
            remaining.append({**missing, "entityMethod": "duplicate-entity-in-year", "entityId": entity["id"]})
            continue

        candidate_block["records"].append(normalized_record(source, entity["id"], source_block["rankingMode"]))
        recovered.append({
            "year": year,
            "sourceName": source["sourceName"],
            "hospitalId": entity["id"],
            "canonicalName": entity["name"],
            "method": method,
            "score": round(score, 4),
        })
        if source["sourceName"] not in entity["aliases"] and source["sourceName"] != entity["name"]:
            entity["aliases"].append(source["sourceName"])
            entity["aliases"].sort()
        if method == "entity-fuzzy":
            fuzzy.append(recovered[-1])

    # Preserve source table order for every year.
    for year, block in candidate_by_year.items():
        source_order = {record["sourceName"]: index for index, record in enumerate(source_by_year[year]["records"])}
        block["records"].sort(key=lambda record: source_order.get(record["sourceName"], 10**9))

    audit["entityRecovery"] = recovered
    audit["entityRecoveryFuzzy"] = fuzzy
    audit["unmatchedSource"] = remaining
    audit["summary"]["entityRecovered"] = len(recovered)
    audit["summary"]["entityRecoveryFuzzy"] = len(fuzzy)
    audit["summary"]["unmatchedSource"] = len(remaining)
    audit["status"] = "ok" if not remaining and not audit.get("unmatchedLegacy") else "needs-review"

    year_audit = {int(item["year"]): item for item in audit["years"]}
    for year, block in candidate_by_year.items():
        item = year_audit[year]
        item["normalizedCount"] = len(block["records"])
        item["unmatchedSourceCount"] = len(source_by_year[year]["records"]) - len(block["records"])

    dump(candidate_path, candidate)
    dump(audit_path, audit)
    print(json.dumps({
        "recovered": len(recovered),
        "fuzzy": len(fuzzy),
        "remaining": len(remaining),
        "status": audit["status"],
    }, ensure_ascii=False, indent=2))
    if remaining:
        print(json.dumps(remaining, ensure_ascii=False, indent=2))
    return 0 if not remaining else 2


if __name__ == "__main__":
    raise SystemExit(main())
