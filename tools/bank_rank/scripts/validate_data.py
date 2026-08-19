#!/usr/bin/env python3
"""Validate bank_rank manifest, entities, yearly records and source digests."""
from __future__ import annotations
import argparse, hashlib, json
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
ALLOWED_TYPES = {"大型商业银行","全国性股份制商业银行","城市商业银行","农村商业银行","民营银行","外资法人银行"}


def load_json(path: Path) -> Any: return json.loads(path.read_text(encoding="utf-8"))

def load_rankings(data_dir: Path = DATA_DIR) -> dict[str, Any]:
    manifest = load_json(data_dir / "rankings.json")
    return {**manifest,
        "banks": load_json(data_dir / manifest["banksFile"]),
        "relations": load_json(data_dir / manifest["relationsFile"]),
        "years": [{**b, "records": load_json(data_dir / b["recordsFile"])} for b in manifest["years"]]}

def load_snapshot(data_dir: Path = DATA_DIR) -> dict[str, Any]: return load_json(data_dir / "source-snapshot.json")

def records_digest(records: list[dict[str, Any]]) -> str:
    raw = json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()

def _round_trillion(value_in_100m: float) -> float: return round(value_in_100m / 10000, 2)

def validate_dataset(data: dict[str, Any], snapshot: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schemaVersion") != 1: errors.append("rankings.json schemaVersion must be 1")
    if snapshot.get("schemaVersion") != 1: errors.append("source-snapshot.json schemaVersion must be 1")
    banks, years, snapshot_years = data.get("banks"), data.get("years"), snapshot.get("years")
    if not isinstance(banks, list) or not isinstance(years, list): return errors + ["rankings banks/years must be arrays"]
    if not isinstance(snapshot_years, list): return errors + ["source snapshot years must be an array"]

    bank_types = data.get("bankTypes")
    if not isinstance(bank_types, list) or not all(isinstance(value, str) for value in bank_types):
        errors.append("bankTypes must be an array of strings")
    else:
        if len(bank_types) != len(set(bank_types)): errors.append("bankTypes must not contain duplicates")
        if set(bank_types) != ALLOWED_TYPES: errors.append("bankTypes must exactly cover the supported bank types")

    bank_ids: set[str] = set(); all_names: dict[str, str] = {}; bank_by_id: dict[str, dict[str, Any]] = {}
    for bank in banks:
        bank_id, name, bank_type, aliases = bank.get("id"), bank.get("name"), bank.get("type"), bank.get("aliases", [])
        if not isinstance(bank_id, str) or not bank_id.startswith("b_"): errors.append(f"invalid bank id: {bank_id!r}"); continue
        if bank_id in bank_ids: errors.append(f"duplicate bank id: {bank_id}")
        bank_ids.add(bank_id); bank_by_id[bank_id] = bank
        if not isinstance(name, str) or not name.strip(): errors.append(f"{bank_id}: invalid canonical name")
        if bank_type not in ALLOWED_TYPES: errors.append(f"{bank_id}: invalid bank type {bank_type!r}")
        if not isinstance(aliases, list): errors.append(f"{bank_id}: aliases must be an array"); aliases = []
        for value in [name, *aliases]:
            if not isinstance(value, str) or not value.strip(): errors.append(f"{bank_id}: empty/invalid name or alias"); continue
            owner = all_names.get(value)
            if owner and owner != bank_id: errors.append(f"name/alias collision: {value} -> {owner}, {bank_id}")
            all_names[value] = bank_id

    year_numbers = [b.get("rankingYear") for b in years]
    if len(year_numbers) != len(set(year_numbers)): errors.append("duplicate rankingYear")
    if year_numbers != sorted(year_numbers): errors.append("years must be sorted ascending by rankingYear")
    integer_years = [year for year in year_numbers if isinstance(year, int)]
    scope = data.get("scope")
    if not isinstance(scope, dict):
        errors.append("scope must be an object")
    elif integer_years and len(integer_years) == len(year_numbers):
        if scope.get("minRankingYear") != min(integer_years): errors.append("scope minRankingYear does not match loaded years")
        if scope.get("maxRankingYear") != max(integer_years): errors.append("scope maxRankingYear does not match loaded years")
        pending = scope.get("historicalBackfillPending")
        if not isinstance(pending, list) or not all(isinstance(year, int) for year in pending):
            errors.append("scope historicalBackfillPending must be an array of years")
        else:
            if len(pending) != len(set(pending)): errors.append("scope historicalBackfillPending must not contain duplicates")
            covered = set(integer_years)
            pending_set = set(pending)
            if covered & pending_set: errors.append("scope historicalBackfillPending contains an already loaded year")
            expected = set(range(min(integer_years), max(integer_years) + 1))
            if covered | pending_set != expected: errors.append("scope years and historicalBackfillPending do not form a complete range")
    snap_map = {b.get("rankingYear"): b for b in snapshot_years}
    if set(year_numbers) != set(snap_map): errors.append("rankings/source-snapshot year sets differ")

    for block in years:
        year, data_year, records = block.get("rankingYear"), block.get("dataYear"), block.get("records")
        if not isinstance(year, int) or not isinstance(data_year, int): errors.append(f"invalid year metadata: {year!r}/{data_year!r}"); continue
        if data_year != year - 1: errors.append(f"{year}: dataYear must equal rankingYear - 1")
        if not isinstance(records, list): errors.append(f"{year}: records must be an array"); continue
        if len(records) != 100: errors.append(f"{year}: expected 100 records, got {len(records)}")
        seen_banks: set[str] = set(); previous_core: float | None = None; previous_rank: int | None = None
        for index, record in enumerate(records):
            prefix = f"{year} row {index + 1}"; bank_id = record.get("bankId"); rank = record.get("rank"); core = record.get("coreTier1Capital"); assets = record.get("assets"); profit = record.get("netProfit"); source_name = record.get("sourceName")
            bank = bank_by_id.get(bank_id)
            if bank is None: errors.append(f"{prefix}: unknown bankId {bank_id!r}")
            if bank_id in seen_banks: errors.append(f"{prefix}: duplicate bankId within year {bank_id}")
            seen_banks.add(bank_id)
            if not isinstance(source_name, str) or not source_name.strip():
                errors.append(f"{prefix}: invalid sourceName")
            elif bank is not None:
                aliases = bank.get("aliases", []) if isinstance(bank.get("aliases", []), list) else []
                if source_name not in {bank.get("name"), *aliases}: errors.append(f"{prefix}: sourceName {source_name!r} does not belong to bankId {bank_id}")
            if not isinstance(rank, int) or rank < 1 or rank > 100: errors.append(f"{prefix}: invalid rank {rank!r}")
            if not isinstance(core, (int,float)) or core <= 0: errors.append(f"{prefix}: invalid coreTier1Capital {core!r}"); continue
            if not isinstance(assets, (int,float)) or assets <= 0: errors.append(f"{prefix}: invalid assets {assets!r}")
            if not isinstance(profit, (int,float)): errors.append(f"{prefix}: invalid netProfit {profit!r}")
            expected_rank = 1 if index == 0 else (previous_rank if core == previous_core else index + 1)
            if rank != expected_rank: errors.append(f"{prefix}: competition rank mismatch; expected {expected_rank}, got {rank}")
            if previous_core is not None and core > previous_core: errors.append(f"{prefix}: core Tier 1 capital is not non-increasing")
            previous_core, previous_rank = float(core), rank

        composition = block.get("officialComposition")
        if composition is not None:
            if not isinstance(composition, dict) or not all(isinstance(key, str) and isinstance(value, int) and value >= 0 for key, value in composition.items()):
                errors.append(f"{year}: officialComposition must map bank types to non-negative integer counts")
            else:
                unknown_types = set(composition) - ALLOWED_TYPES
                if unknown_types: errors.append(f"{year}: officialComposition contains unsupported bank types: {sorted(unknown_types)}")
                if sum(composition.values()) != 100: errors.append(f"{year}: officialComposition must sum to 100")
                actual_counts = Counter(bank_by_id[record["bankId"]]["type"] for record in records if record.get("bankId") in bank_by_id)
                for bank_type in ALLOWED_TYPES:
                    expected_count = composition.get(bank_type, 0)
                    actual_count = actual_counts.get(bank_type, 0)
                    if actual_count != expected_count:
                        errors.append(f"{year}: bank type count mismatch for {bank_type}: table={actual_count}, official={expected_count}")

        metric_map = {"coreTier1CapitalTrillion":"coreTier1Capital","assetsTrillion":"assets","netProfitTrillion":"netProfit"}
        for summary_key, field in metric_map.items():
            if summary_key in block.get("officialSummary", {}):
                actual = _round_trillion(sum(float(r[field]) for r in records)); expected = float(block["officialSummary"][summary_key])
                if actual != expected: errors.append(f"{year}: {summary_key} mismatch after rounding: table={actual}, official={expected}")
        snap = snap_map.get(year)
        if not snap: continue
        if snap.get("recordCount") != len(records): errors.append(f"{year}: snapshot recordCount mismatch")
        actual_digest = records_digest(records)
        expected_digest = snap.get("normalizedRecordsSha256")
        if expected_digest != actual_digest: errors.append(f"{year}: source snapshot digest mismatch: snapshot={expected_digest}, actual={actual_digest}")
        for field in ("dataYear","publishedAt","officialUrl","transcriptionUrl"):
            if snap.get(field) != block.get(field): errors.append(f"{year}: source snapshot metadata mismatch for {field}")

    relation_ids = {r.get("bankId") for r in data.get("relations", [])}
    unknown = relation_ids - bank_ids
    if unknown: errors.append(f"relations reference unknown bank ids: {sorted(unknown)}")
    return errors

def main() -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--data-dir", type=Path, default=DATA_DIR); args=parser.parse_args()
    data=load_rankings(args.data_dir); snapshot=load_snapshot(args.data_dir); errors=validate_dataset(data,snapshot)
    if errors:
        print("bank_rank validation FAILED")
        for error in errors: print(f"- {error}")
        return 1
    print(f"bank_rank validation OK: {len(data['banks'])} bank entities, {sum(len(b['records']) for b in data['years'])} records, {len(data['years'])} ranking years")
    return 0

if __name__ == "__main__": raise SystemExit(main())
