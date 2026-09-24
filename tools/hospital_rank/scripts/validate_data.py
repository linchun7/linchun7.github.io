#!/usr/bin/env python3
"""Validate committed hospital ranking JSON without network access."""
from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

GRADE_ORDER = ["A++++", "A+++", "A++", "A+", "A"]
BASELINE_COUNTS = {2009: 50, 2010: 80, **{year: 100 for year in range(2011, 2024)}}
BASELINE_RECORDS = sum(BASELINE_COUNTS.values())
# 127 distinct hospitals after the source-backed Sun Yat-sen alias correction.
BASELINE_HOSPITAL_ENTITIES = 127


def load(path: Path) -> Any:
    def reject_constant(value: str) -> None:
        raise ValueError(f"non-standard JSON number: {value}")
    return json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant)


def norm(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    return re.sub(r"[\s()（）\[\]【】{}·•,，。;；:：'\"“”‘’/\\\-—_]+", "", value).lower()


def fail(message: str) -> None:
    raise AssertionError(message)


def same_number(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is b
    try:
        return math.isclose(float(a), float(b), rel_tol=0.0, abs_tol=1e-9)
    except (TypeError, ValueError):
        return False


def check_year_blocks(blocks: Any, *, snapshot: bool = False) -> None:
    if not isinstance(blocks, list) or not blocks:
        fail("years must be a non-empty array")
    scores = ("specialtyReputation", "researchAcademic", "overallScore")
    for block in blocks:
        if not isinstance(block, dict):
            fail("year block must be an object")
        year = block.get("year")
        if type(year) is not int or not 2009 <= year <= 9999:
            fail("year must be an integer >= 2009")
        mode = block.get("rankingMode")
        if mode not in ("numeric", "grade"):
            fail(f"{year}: unsupported ranking mode")
        if year in BASELINE_COUNTS and mode != ("grade" if year == 2023 else "numeric"):
            fail(f"{year}: historical ranking mode changed")
        rows = block.get("records")
        if not isinstance(rows, list) or not rows:
            fail(f"{year}: records must be a non-empty array")
        previous_rank = 0
        required = {"sourceName", "rank", "grade", *scores}
        if snapshot:
            required = {"sourceName", "rank", *scores} if mode == "numeric" else {"sourceName", "grade"}
        for row in rows:
            if not isinstance(row, dict) or not required.issubset(row):
                fail(f"{year}: missing required ranking fields")
            if not isinstance(row["sourceName"], str) or not row["sourceName"].strip():
                fail(f"{year}: sourceName must be a non-empty string")
            if mode == "numeric":
                rank = row["rank"]
                # Preserve official ties, including 2009's 27, 27, 29.
                if type(rank) is not int or rank <= 0 or rank < previous_rank or row.get("grade") is not None:
                    fail(f"{year}: invalid/non-monotonic numeric rank")
                previous_rank = rank
                for field in scores:
                    value = row[field]
                    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                        fail(f"{year}: {field} must be finite and non-negative")
            elif row.get("rank") is not None or row["grade"] not in GRADE_ORDER or any(row.get(f) is not None for f in scores):
                fail(f"{year}: grade row must not invent ranks or scores")


def main() -> int:
    parser = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[1] / "data"
    parser.add_argument("--data-dir", type=Path, default=root)
    args = parser.parse_args()

    rankings = load(args.data_dir / "rankings.json")
    snapshot = load(args.data_dir / "source-snapshot.json")
    audit = load(args.data_dir / "audit.json")

    for payload in (rankings, snapshot, audit):
        if not isinstance(payload, dict) or type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != 1:
            fail("schemaVersion must be integer 1 for all hospital data files")
    if rankings.get("rankingModes", {}).get("grade", {}).get("grades") != GRADE_ORDER:
        fail("rankingModes.grade.grades must preserve the official grade order")
    check_year_blocks(rankings.get("years"))
    check_year_blocks(snapshot.get("years"), snapshot=True)
    if snapshot.get("source", {}).get("rawHtmlStored") is not False:
        fail("source snapshot must explicitly declare rawHtmlStored=false")
    if audit.get("status") != "ok":
        fail(f"migration audit is not ok: {audit.get('status')}")
    if audit.get("summary", {}).get("unmatchedSource") != 0 or audit.get("summary", {}).get("unmatchedLegacy") != 0:
        fail("migration audit still has unmatched records")
    if audit.get("summary", {}).get("valueDifferences") != 0:
        fail("migration audit has unresolved source/legacy value differences")
    if audit.get("summary", {}).get("entityRecoveryFuzzy") != 0:
        fail("migration baseline must not depend on fuzzy entity recovery")

    hospitals = rankings.get("hospitals")
    years = rankings.get("years")
    if not isinstance(hospitals, list) or not isinstance(years, list):
        fail("rankings.hospitals and rankings.years must be arrays")

    hospital_by_id: dict[str, dict[str, Any]] = {}
    token_owner: dict[str, str] = {}
    for hospital in hospitals:
        if not isinstance(hospital, dict):
            fail("hospital entity must be an object")
        for field in ("id", "name", "province", "city"):
            if not isinstance(hospital.get(field), str) or not hospital[field].strip():
                fail(f"hospital {field} must be a non-empty string")
        aliases = hospital.get("aliases")
        if not isinstance(aliases, list) or any(not isinstance(a, str) or not a.strip() for a in aliases):
            fail("aliases must be an array of non-empty strings")
        hospital_id = hospital.get("id")
        if not isinstance(hospital_id, str) or not re.fullmatch(r"h_[0-9a-f]{10}", hospital_id):
            fail(f"invalid hospital id: {hospital_id!r}")
        if hospital_id in hospital_by_id:
            fail(f"duplicate hospital id: {hospital_id}")
        if not hospital.get("name"):
            fail(f"hospital {hospital_id} has no canonical name")
        if not hospital.get("province") or not hospital.get("city"):
            fail(f"hospital {hospital['name']} has incomplete location metadata")
        hospital_by_id[hospital_id] = hospital

        names = [hospital["name"], *(hospital.get("aliases") or [])]
        if len(names) != len(set(names)):
            fail(f"hospital {hospital['name']} has duplicate aliases")
        for name in names:
            token = norm(name)
            if not token:
                fail(f"hospital {hospital['name']} has an empty normalized name")
            previous = token_owner.get(token)
            if previous and previous != hospital_id:
                fail(f"name/alias collision between {previous} and {hospital_id}: {name}")
            token_owner[token] = hospital_id

    source_by_year = {int(block["year"]): block for block in snapshot.get("years", [])}
    normalized_by_year = {int(block["year"]): block for block in years}
    if len(source_by_year) != len(snapshot.get("years", [])) or len(normalized_by_year) != len(years):
        fail("duplicate year blocks are not allowed")
    if not set(BASELINE_COUNTS).issubset(source_by_year) or not set(BASELINE_COUNTS).issubset(normalized_by_year):
        fail("verified 2009–2023 historical baseline must remain complete")
    if set(source_by_year) != set(normalized_by_year):
        fail("source snapshot and normalized rankings must contain the same years")

    used_hospital_ids: set[str] = set()
    total_records = 0
    baseline_records = 0
    for year in sorted(normalized_by_year):
        source_block = source_by_year[year]
        block = normalized_by_year[year]
        if source_block.get("rankingMode") != block.get("rankingMode"):
            fail(f"{year}: source and normalized rankingMode differ")

        source_rows = source_block.get("records", [])
        normalized_rows = block.get("records", [])
        if [r["sourceName"] for r in source_rows] != [r["sourceName"] for r in normalized_rows]:
            fail(f"{year}: source record order must be preserved")
        if year in BASELINE_COUNTS:
            expected_count = BASELINE_COUNTS[year]
            if len(source_rows) != expected_count or len(normalized_rows) != expected_count:
                fail(f"{year}: verified baseline record count changed")
        elif year <= 2023:
            fail(f"unexpected pre-baseline year: {year}")
        elif not source_rows or len(source_rows) != len(normalized_rows):
            fail(f"{year}: future year must have a non-empty source-aligned record set")

        mode = block.get("rankingMode")
        if mode not in {"numeric", "grade"}:
            fail(f"{year}: unsupported rankingMode {mode!r}")
        source_records = {record["sourceName"]: record for record in source_rows}
        if len(source_records) != len(source_rows):
            fail(f"{year}: duplicate source names in source snapshot")
        seen_ids: set[str] = set()
        seen_source_names: set[str] = set()
        previous_rank = 0
        grades = Counter()

        for record in normalized_rows:
            total_records += 1
            if year in BASELINE_COUNTS:
                baseline_records += 1
            hospital_id = record.get("hospitalId")
            source_name = record.get("sourceName")
            if hospital_id not in hospital_by_id:
                fail(f"{year}: unknown hospitalId {hospital_id}")
            if hospital_id in seen_ids:
                fail(f"{year}: duplicate hospital entity {hospital_id}")
            if not source_name or source_name in seen_source_names:
                fail(f"{year}: empty or duplicate sourceName {source_name!r}")
            seen_ids.add(hospital_id)
            seen_source_names.add(source_name)
            used_hospital_ids.add(hospital_id)

            hospital = hospital_by_id[hospital_id]
            if source_name != hospital["name"] and source_name not in hospital.get("aliases", []):
                fail(f"{year}: sourceName is not preserved in entity aliases: {source_name}")
            source = source_records.get(source_name)
            if source is None:
                fail(f"{year}: normalized sourceName absent from source snapshot: {source_name}")

            if mode == "numeric":
                if record.get("grade") is not None:
                    fail(f"{year}: numeric row has grade: {source_name}")
                rank = record.get("rank")
                if not isinstance(rank, int) or rank < previous_rank:
                    fail(f"{year}: invalid/non-monotonic numeric rank for {source_name}: {rank}")
                previous_rank = rank
                for field in ("rank", "specialtyReputation", "researchAcademic", "overallScore"):
                    if not same_number(record.get(field), source.get(field)):
                        fail(f"{year}: {field} differs from source snapshot for {source_name}")
            else:
                if record.get("rank") is not None:
                    fail(f"{year}: grade row has numeric rank: {source_name}")
                grade = record.get("grade")
                if grade not in GRADE_ORDER:
                    fail(f"{year}: invalid grade {grade!r} for {source_name}")
                grades[grade] += 1
                for field in ("specialtyReputation", "researchAcademic", "overallScore"):
                    if record.get(field) is not None:
                        fail(f"{year}: grade row must not invent {field}: {source_name}")
                if source.get("grade") != grade:
                    fail(f"{year}: grade differs from source snapshot for {source_name}")

        if mode == "grade" and any(grade not in GRADE_ORDER for grade in grades):
            fail(f"{year}: unsupported grade values")
        if year == 2023 and any(grades[grade] != 20 for grade in GRADE_ORDER):
            fail(f"2023: expected verified 20 hospitals per grade, got {dict(grades)}")

    if baseline_records != BASELINE_RECORDS:
        fail(f"verified historical baseline must remain {BASELINE_RECORDS} records, got {baseline_records}")
    if total_records < BASELINE_RECORDS:
        fail(f"record count cannot fall below verified baseline {BASELINE_RECORDS}")
    unused = set(hospital_by_id) - used_hospital_ids
    if unused:
        fail(f"unused hospital entities: {sorted(unused)}")
    if len(hospital_by_id) < BASELINE_HOSPITAL_ENTITIES:
        fail(f"hospital entities cannot fall below verified baseline {BASELINE_HOSPITAL_ENTITIES}")

    print(json.dumps({
        "status": "ok",
        "years": len(normalized_by_year),
        "latestYear": max(normalized_by_year),
        "records": total_records,
        "baselineRecords": baseline_records,
        "hospitalEntities": len(hospital_by_id),
        "sourceValidationWarnings": len(audit.get("sourceValidationWarnings", [])),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
