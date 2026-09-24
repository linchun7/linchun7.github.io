#!/usr/bin/env python3
"""Validate bank_rank manifest, entities, yearly records and source digests."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import date
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
ALLOWED_TYPES = {"大型商业银行", "全国性股份制商业银行", "城市商业银行", "农村商业银行", "民营银行", "外资法人银行"}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def data_path(data_dir: Path, value: Any) -> Path:
    if not isinstance(value, str) or not re.fullmatch(r"(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.json", value):
        raise ValueError(f"invalid data file path: {value!r}")
    path = (data_dir / value).resolve()
    if not path.is_relative_to(data_dir.resolve()):
        raise ValueError(f"data file path escapes data directory: {value!r}")
    return path


def finite_number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def https_url(value: Any) -> bool:
    if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 or c == "\\" for c in value):
        return False
    try:
        parsed = urlsplit(value)
        return bool(parsed.scheme == "https" and parsed.hostname and parsed.username is None
                    and parsed.password is None and (parsed.port is None or 0 < parsed.port <= 65535))
    except ValueError:
        return False


def iso_date(value: Any) -> bool:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def load_rankings(data_dir: Path = DATA_DIR) -> dict[str, Any]:
    manifest = load_json(data_dir / "rankings.json")
    if not isinstance(manifest, dict) or not isinstance(manifest.get("years"), list) or not manifest["years"]:
        raise ValueError("rankings manifest must contain non-empty years")
    # Check every manifest-controlled path before opening any subordinate file.
    banks_path = data_path(data_dir, manifest.get("banksFile"))
    relations_path = data_path(data_dir, manifest.get("relationsFile"))
    year_paths = [data_path(data_dir, block.get("recordsFile") if isinstance(block, dict) else None)
                  for block in manifest["years"]]
    return {**manifest, "banks": load_json(banks_path), "relations": load_json(relations_path),
            "years": [{**block, "records": load_json(path)} for block, path in zip(manifest["years"], year_paths)]}


def load_snapshot(data_dir: Path = DATA_DIR) -> dict[str, Any]:
    return load_json(data_dir / "source-snapshot.json")


def records_digest(records: list[dict[str, Any]]) -> str:
    raw = json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _round_trillion(value_in_100m: float) -> float:
    return round(value_in_100m / 10000, 2)


def validate_dataset(data: dict[str, Any], snapshot: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict) or not isinstance(snapshot, dict):
        return ["dataset and snapshot must be objects"]
    for label, obj in (("rankings.json", data), ("source-snapshot.json", snapshot)):
        if type(obj.get("schemaVersion")) is not int or obj["schemaVersion"] != 1:
            errors.append(f"{label} schemaVersion must be 1")
    if data.get("banksFile") != "banks.json" or data.get("relationsFile") != "relations.json":
        errors.append("invalid banksFile/relationsFile path")
    banks, years, snapshot_years = data.get("banks"), data.get("years"), snapshot.get("years")
    if any(not isinstance(items, list) or not items for items in (banks, years, snapshot_years)):
        return errors + ["banks, years and snapshot years must be non-empty arrays"]
    if any(not isinstance(item, dict) for item in [*banks, *years, *snapshot_years]):
        return errors + ["banks, years and snapshot entries must be objects"]
    bank_types = data.get("bankTypes")
    if not isinstance(bank_types, list) or not all(isinstance(value, str) for value in bank_types):
        errors.append("bankTypes must be an array of strings")
    elif len(bank_types) != len(set(bank_types)) or set(bank_types) != ALLOWED_TYPES:
        errors.append("bankTypes must exactly cover the supported bank types without duplicates")

    all_names: dict[str, str] = {}
    bank_by_id: dict[str, dict[str, Any]] = {}
    for bank in banks:
        bank_id, name, bank_type, aliases = bank.get("id"), bank.get("name"), bank.get("type"), bank.get("aliases", [])
        if not isinstance(bank_id, str) or not re.fullmatch(r"b_[a-z0-9]+", bank_id):
            errors.append(f"invalid bank id: {bank_id!r}")
            continue
        if bank_id in bank_by_id:
            errors.append(f"duplicate bank id: {bank_id}")
        bank_by_id[bank_id] = bank
        if not isinstance(bank_type, str) or bank_type not in ALLOWED_TYPES:
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
    if errors:
        return errors

    year_numbers = [block.get("rankingYear") for block in years]
    if any(type(year) is not int or not 1000 <= year <= 9999 for year in year_numbers):
        return ["rankingYear must be a four-digit integer"]
    if len(year_numbers) != len(set(year_numbers)):
        errors.append("duplicate rankingYear")
    if year_numbers != sorted(year_numbers):
        errors.append("years must be sorted ascending by rankingYear")
    scope = data.get("scope")
    if not isinstance(scope, dict):
        errors.append("scope must be an object")
    else:
        if scope.get("minRankingYear") != min(year_numbers) or scope.get("maxRankingYear") != max(year_numbers):
            errors.append("scope minRankingYear/maxRankingYear do not match loaded years")
        pending = scope.get("historicalBackfillPending")
        if not isinstance(pending, list) or not all(type(year) is int for year in pending):
            errors.append("scope historicalBackfillPending must be an array of years")
        else:
            covered, missing = set(year_numbers), set(pending)
            if len(pending) != len(missing) or covered & missing:
                errors.append("scope historicalBackfillPending has duplicates or loaded years")
            if covered | missing != set(range(min(year_numbers), max(year_numbers) + 1)):
                errors.append("scope years and historicalBackfillPending do not form a complete range")
    if any(type(block.get("rankingYear")) is not int for block in snapshot_years):
        return errors + ["snapshot rankingYear must be an integer"]
    snap_map = {block["rankingYear"]: block for block in snapshot_years}
    if len(snap_map) != len(snapshot_years):
        errors.append("duplicate source-snapshot rankingYear")
    if set(year_numbers) != set(snap_map):
        errors.append("rankings/source-snapshot year sets differ")

    for block in years:
        year, data_year, records = block.get("rankingYear"), block.get("dataYear"), block.get("records")
        if block.get("recordsFile") != f"years/{year}.json":
            errors.append(f"{year}: invalid recordsFile path")
        if type(data_year) is not int or data_year != year - 1:
            errors.append(f"{year}: dataYear must equal rankingYear - 1")
        for field in ("officialUrl", "transcriptionUrl"):
            if not https_url(block.get(field)):
                errors.append(f"{year}: invalid HTTPS {field}")
        if "publishedAt" in block and not iso_date(block["publishedAt"]):
            errors.append(f"{year}: invalid publishedAt date")
        if not isinstance(records, list):
            errors.append(f"{year}: records must be an array")
            continue
        if len(records) != 100:
            errors.append(f"{year}: expected 100 records, got {len(records)}")
        seen_banks: set[str] = set()
        previous_core, previous_rank = None, None
        for index, record in enumerate(records):
            prefix = f"{year} row {index + 1}"
            if not isinstance(record, dict):
                errors.append(f"{prefix}: record must be an object")
                continue
            bank_id, rank = record.get("bankId"), record.get("rank")
            core, assets, profit = (record.get(field) for field in ("coreTier1Capital", "assets", "netProfit"))
            if not isinstance(bank_id, str):
                errors.append(f"{prefix}: invalid bankId")
                continue
            bank = bank_by_id.get(bank_id)
            if bank is None:
                errors.append(f"{prefix}: unknown bankId {bank_id!r}")
            if bank_id in seen_banks:
                errors.append(f"{prefix}: duplicate bankId within year {bank_id}")
            seen_banks.add(bank_id)
            name = record.get("sourceName")
            if not isinstance(name, str) or not name.strip() or all_names.get(name) != bank_id:
                errors.append(f"{prefix}: invalid sourceName or sourceName does not belong to bankId")
            if type(rank) is not int or not 1 <= rank <= 100:
                errors.append(f"{prefix}: invalid rank {rank!r}")
            if not finite_number(assets) or assets <= 0:
                errors.append(f"{prefix}: invalid assets {assets!r}")
            if not finite_number(profit):
                errors.append(f"{prefix}: invalid netProfit {profit!r}")
            if not finite_number(core) or core <= 0:
                errors.append(f"{prefix}: invalid coreTier1Capital {core!r}")
                continue
            expected_rank = 1 if index == 0 else (previous_rank if core == previous_core else index + 1)
            if rank != expected_rank:
                errors.append(f"{prefix}: competition rank mismatch; expected {expected_rank}, got {rank}")
            if previous_core is not None and core > previous_core:
                errors.append(f"{prefix}: core Tier 1 capital is not non-increasing")
            previous_core, previous_rank = core, rank

        composition = block.get("officialComposition")
        if composition is not None:
            if not isinstance(composition, dict) or not all(isinstance(key, str) and type(value) is int and value >= 0 for key, value in composition.items()):
                errors.append(f"{year}: officialComposition must map bank types to non-negative integer counts")
            else:
                if set(composition) - ALLOWED_TYPES or sum(composition.values()) != 100:
                    errors.append(f"{year}: officialComposition must cover supported types and sum to 100")
                counts = Counter(bank_by_id[row["bankId"]]["type"] for row in records
                                 if isinstance(row, dict) and isinstance(row.get("bankId"), str) and row["bankId"] in bank_by_id)
                for bank_type in ALLOWED_TYPES:
                    if counts.get(bank_type, 0) != composition.get(bank_type, 0):
                        errors.append(f"{year}: bank type count mismatch for {bank_type}")
        summary = block.get("officialSummary", {})
        if not isinstance(summary, dict):
            errors.append(f"{year}: officialSummary must be an object")
            summary = {}
        for summary_key, field in {"coreTier1CapitalTrillion": "coreTier1Capital", "assetsTrillion": "assets", "netProfitTrillion": "netProfit"}.items():
            if summary_key not in summary:
                continue
            if not finite_number(summary[summary_key]):
                errors.append(f"{year}: invalid official summary {summary_key}")
                continue
            if not all(isinstance(row, dict) and finite_number(row.get(field)) for row in records):
                continue
            actual = _round_trillion(sum(row[field] for row in records))
            if actual != summary[summary_key]:
                errors.append(f"{year}: {summary_key} mismatch after rounding: table={actual}, official={summary[summary_key]}")
        snap = snap_map.get(year)
        if snap is not None:
            if snap.get("recordCount") != len(records):
                errors.append(f"{year}: snapshot recordCount mismatch")
            if snap.get("normalizedRecordsSha256") != records_digest(records):
                errors.append(f"{year}: source snapshot digest mismatch")
            for field in ("dataYear", "publishedAt", "officialUrl", "transcriptionUrl"):
                if snap.get(field) != block.get(field):
                    errors.append(f"{year}: source snapshot metadata mismatch for {field}")

    relations = data.get("relations")
    if not isinstance(relations, list):
        return errors + ["relations must be an array"]
    seen_relations = set()
    for relation in relations:
        if not isinstance(relation, dict):
            errors.append("relation must be an object")
            continue
        bank_id = relation.get("bankId")
        if not isinstance(bank_id, str) or bank_id not in bank_by_id:
            errors.append(f"relation references unknown bankId: {bank_id!r}")
            continue
        bank = bank_by_id[bank_id]
        names = {bank["name"], *bank.get("aliases", [])}
        kind, old, new = relation.get("type"), relation.get("fromName"), relation.get("toName")
        if kind not in ("renamed", "formed_from"):
            errors.append(f"{bank_id}: invalid relation type")
        if not iso_date(relation.get("date")):
            errors.append(f"{bank_id}: invalid relation date")
        if not https_url(relation.get("sourceUrl")):
            errors.append(f"{bank_id}: invalid relation sourceUrl")
        if not isinstance(old, str) or not old.strip() or (kind == "renamed" and old not in names):
            errors.append(f"{bank_id}: invalid relation fromName")
        if not isinstance(new, str) or new not in names:
            errors.append(f"{bank_id}: invalid relation toName")
        if old == new:
            errors.append(f"{bank_id}: relation must change name or entity")
        if not isinstance(relation.get("note", ""), str):
            errors.append(f"{bank_id}: relation note must be text")
        key = json.dumps(relation, sort_keys=True, ensure_ascii=False)
        if key in seen_relations:
            errors.append(f"{bank_id}: duplicate relation")
        seen_relations.add(key)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    args = parser.parse_args()
    try:
        data = load_rankings(args.data_dir)
        errors = validate_dataset(data, load_snapshot(args.data_dir))
    except (OSError, ValueError, TypeError) as exc:
        errors = [str(exc)]
    if errors:
        print("bank_rank validation FAILED")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"bank_rank validation OK: {len(data['banks'])} bank entities, {sum(len(b['records']) for b in data['years'])} records, {len(data['years'])} ranking years")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
