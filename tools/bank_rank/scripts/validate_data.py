#!/usr/bin/env python3
"""Validate bank_rank structured data.

The validator intentionally allows competition ranking ties. Example: the 2024
list contains ranks 95, 95, 97 because two banks share the same published
core Tier 1 capital.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "rankings.json"
SNAPSHOT_PATH = ROOT / "data" / "source-snapshot.json"

ALLOWED_TYPES = {
    "大型商业银行",
    "全国性股份制商业银行",
    "城市商业银行",
    "农村商业银行",
    "民营银行",
    "外资法人银行",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _round_trillion(value_in_100m: float) -> float:
    # 1万亿元 = 10000亿元
    return round(value_in_100m / 10000, 2)


def validate_dataset(data: dict[str, Any], snapshot: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    if data.get("schemaVersion") != 1:
        errors.append("rankings.json schemaVersion must be 1")
    if snapshot.get("schemaVersion") != 1:
        errors.append("source-snapshot.json schemaVersion must be 1")

    banks = data.get("banks")
    years = data.get("years")
    snapshot_years = snapshot.get("years")
    if not isinstance(banks, list) or not isinstance(years, list):
        return errors + ["rankings.json banks/years must be arrays"]
    if not isinstance(snapshot_years, list):
        return errors + ["source-snapshot.json years must be an array"]

    bank_ids: set[str] = set()
    all_names: dict[str, str] = {}
    bank_by_id: dict[str, dict[str, Any]] = {}

    for bank in banks:
        bank_id = bank.get("id")
        name = bank.get("name")
        bank_type = bank.get("type")
        aliases = bank.get("aliases", [])

        if not isinstance(bank_id, str) or not bank_id.startswith("b_"):
            errors.append(f"invalid bank id: {bank_id!r}")
            continue
        if bank_id in bank_ids:
            errors.append(f"duplicate bank id: {bank_id}")
        bank_ids.add(bank_id)
        bank_by_id[bank_id] = bank

        if not isinstance(name, str) or not name.strip():
            errors.append(f"{bank_id}: invalid canonical name")
        if bank_type not in ALLOWED_TYPES:
            errors.append(f"{bank_id}: invalid bank type {bank_type!r}")
        if not isinstance(aliases, list):
            errors.append(f"{bank_id}: aliases must be an array")
            aliases = []

        for value in [name, *aliases]:
            if not isinstance(value, str) or not value.strip():
                errors.append(f"{bank_id}: empty/invalid name or alias")
                continue
            owner = all_names.get(value)
            if owner and owner != bank_id:
                errors.append(f"name/alias collision: {value} -> {owner}, {bank_id}")
            all_names[value] = bank_id

    year_numbers = [block.get("rankingYear") for block in years]
    if len(year_numbers) != len(set(year_numbers)):
        errors.append("duplicate rankingYear")
    if year_numbers != sorted(year_numbers):
        errors.append("years must be sorted ascending by rankingYear")

    snap_map = {block.get("rankingYear"): block for block in snapshot_years}
    if set(year_numbers) != set(snap_map):
        errors.append("rankings/source-snapshot year sets differ")

    for block in years:
        year = block.get("rankingYear")
        data_year = block.get("dataYear")
        records = block.get("records")

        if not isinstance(year, int) or not isinstance(data_year, int):
            errors.append(f"invalid year metadata: {year!r}/{data_year!r}")
            continue
        if data_year != year - 1:
            errors.append(f"{year}: dataYear must equal rankingYear - 1")
        if not isinstance(records, list):
            errors.append(f"{year}: records must be an array")
            continue
        if len(records) != 100:
            errors.append(f"{year}: expected 100 records, got {len(records)}")

        seen_banks: set[str] = set()
        previous_core: float | None = None
        previous_rank: int | None = None

        for index, record in enumerate(records):
            prefix = f"{year} row {index + 1}"
            bank_id = record.get("bankId")
            rank = record.get("rank")
            core = record.get("coreTier1Capital")
            assets = record.get("assets")
            profit = record.get("netProfit")

            if bank_id not in bank_by_id:
                errors.append(f"{prefix}: unknown bankId {bank_id!r}")
            if bank_id in seen_banks:
                errors.append(f"{prefix}: duplicate bankId within year {bank_id}")
            seen_banks.add(bank_id)

            if not isinstance(rank, int) or rank < 1 or rank > 100:
                errors.append(f"{prefix}: invalid rank {rank!r}")
            if not isinstance(core, (int, float)) or core <= 0:
                errors.append(f"{prefix}: invalid coreTier1Capital {core!r}")
                continue
            if not isinstance(assets, (int, float)) or assets <= 0:
                errors.append(f"{prefix}: invalid assets {assets!r}")
            if not isinstance(profit, (int, float)):
                errors.append(f"{prefix}: invalid netProfit {profit!r}")

            expected_rank = 1 if index == 0 else (
                previous_rank if core == previous_core else index + 1
            )
            if rank != expected_rank:
                errors.append(
                    f"{prefix}: competition rank mismatch; expected {expected_rank}, got {rank}"
                )
            if previous_core is not None and core > previous_core:
                errors.append(f"{prefix}: core Tier 1 capital is not non-increasing")

            previous_core = float(core)
            previous_rank = rank

        summary = block.get("officialSummary", {})
        metric_map = {
            "coreTier1CapitalTrillion": "coreTier1Capital",
            "assetsTrillion": "assets",
            "netProfitTrillion": "netProfit",
        }
        for summary_key, field in metric_map.items():
            if summary_key not in summary:
                continue
            total = sum(float(record[field]) for record in records)
            actual = _round_trillion(total)
            expected = float(summary[summary_key])
            if actual != expected:
                errors.append(
                    f"{year}: {summary_key} mismatch after rounding: "
                    f"table={actual}, official={expected}"
                )

        snap = snap_map.get(year)
        if not snap:
            continue
        snap_records = snap.get("records")
        if not isinstance(snap_records, list):
            errors.append(f"{year}: snapshot records must be an array")
            continue
        if len(snap_records) != len(records):
            errors.append(f"{year}: snapshot record count differs")
            continue
        fields = ("sourceName", "rank", "coreTier1Capital", "assets", "netProfit")
        for index, (record, source_record) in enumerate(zip(records, snap_records, strict=True)):
            for field in fields:
                if record.get(field) != source_record.get(field):
                    errors.append(
                        f"{year} row {index + 1}: snapshot mismatch for {field}"
                    )

    relation_ids = {relation.get("bankId") for relation in data.get("relations", [])}
    unknown_relation_ids = relation_ids - bank_ids
    if unknown_relation_ids:
        errors.append(f"relations reference unknown bank ids: {sorted(unknown_relation_ids)}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rankings", type=Path, default=DATA_PATH)
    parser.add_argument("--snapshot", type=Path, default=SNAPSHOT_PATH)
    args = parser.parse_args()

    errors = validate_dataset(load_json(args.rankings), load_json(args.snapshot))
    if errors:
        print("bank_rank validation FAILED")
        for error in errors:
            print(f"- {error}")
        return 1

    data = load_json(args.rankings)
    print(
        "bank_rank validation OK: "
        f"{len(data['banks'])} bank entities, "
        f"{sum(len(block['records']) for block in data['years'])} records, "
        f"{len(data['years'])} ranking years"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
