#!/usr/bin/env python3
"""Validate the bank_rank V4 evidence ledger against the exact production records."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
VERIFICATION_FILE = "verification-v4.json"
ALLOWED_STATUSES = {"verified", "verified_with_legacy_primary_gap"}
ALLOWED_GRADES = {"A1", "A2", "B1", "B2", "C"}
SELF_HOSTS = {"linchun.com.cn"}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def digest(records: list[dict[str, Any]]) -> str:
    raw = json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _https(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("https://") and len(value) > 8


def _host(value: Any) -> str:
    if not _https(value):
        return ""
    host = (urlparse(value).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def _url_key(value: Any) -> tuple[str, str, str] | None:
    if not _https(value):
        return None
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path.rstrip("/") or "/"
    return host, path, parsed.query


def _is_self_source(value: Any) -> bool:
    return _host(value) in SELF_HOSTS


def validate(data_dir: Path = DATA_DIR) -> list[str]:
    errors: list[str] = []
    manifest = load_json(data_dir / "rankings.json")
    snapshot = load_json(data_dir / "source-snapshot.json")
    verification = load_json(data_dir / VERIFICATION_FILE)

    if verification.get("schemaVersion") != 1:
        errors.append("verification schemaVersion must be 1")
    if not isinstance(verification.get("auditVersion"), str) or not verification["auditVersion"].strip():
        errors.append("verification auditVersion must be documented")

    policy = verification.get("policy")
    if not isinstance(policy, dict):
        errors.append("verification policy must be an object")
    else:
        for key in ("conflictRule", "claimBoundary"):
            if not isinstance(policy.get(key), str) or not policy[key].strip():
                errors.append(f"verification policy.{key} must be documented")
        hierarchy = policy.get("sourceHierarchy")
        if not isinstance(hierarchy, list):
            errors.append("source hierarchy must be an array")
        else:
            grades = {item.get("grade") for item in hierarchy if isinstance(item, dict)}
            if grades != ALLOWED_GRADES:
                errors.append(f"source hierarchy must cover {sorted(ALLOWED_GRADES)}")
            if len(hierarchy) != len(ALLOWED_GRADES):
                errors.append("source hierarchy must contain exactly one entry per supported grade")
            for item in hierarchy:
                if not isinstance(item, dict):
                    errors.append("source hierarchy entries must be objects")
                    continue
                if item.get("grade") not in ALLOWED_GRADES:
                    errors.append(f"unsupported source hierarchy grade {item.get('grade')!r}")
                if not isinstance(item.get("description"), str) or not item["description"].strip():
                    errors.append("source hierarchy descriptions must be documented")

    manifest_years = {block["rankingYear"]: block for block in manifest.get("years", [])}
    snapshot_years = {block["rankingYear"]: block for block in snapshot.get("years", [])}
    audit_items = verification.get("years")
    if not isinstance(audit_items, list):
        return errors + ["verification years must be an array"]
    audit_years: dict[int, dict[str, Any]] = {}
    for item in audit_items:
        if not isinstance(item, dict) or not isinstance(item.get("rankingYear"), int):
            errors.append("verification year entries must have integer rankingYear")
            continue
        year = item["rankingYear"]
        if year in audit_years:
            errors.append(f"duplicate verification year {year}")
        audit_years[year] = item

    if set(audit_years) != set(manifest_years):
        errors.append("verification year set must exactly match rankings.json")
    scope = verification.get("scope")
    if not isinstance(scope, dict):
        errors.append("verification scope must be an object")
        scope = {}
    if scope.get("rankingYears") != sorted(manifest_years):
        errors.append("verification scope.rankingYears must match rankings.json")

    total_records = 0
    for year, block in manifest_years.items():
        records = load_json(data_dir / block["recordsFile"])
        total_records += len(records)
        audit = audit_years.get(year)
        if audit is None:
            continue
        if audit.get("dataYear") != block.get("dataYear"):
            errors.append(f"{year}: verification dataYear mismatch")
        if audit.get("status") not in ALLOWED_STATUSES:
            errors.append(f"{year}: invalid verification status {audit.get('status')!r}")

        actual_sha = digest(records)
        if audit.get("recordSha256") != actual_sha:
            errors.append(f"{year}: verification SHA does not match records")
        if snapshot_years.get(year, {}).get("normalizedRecordsSha256") != actual_sha:
            errors.append(f"{year}: source-snapshot SHA does not match records")

        source_urls: dict[str, set[tuple[str, str, str]]] = {
            "authoritativeSources": set(),
            "completeTableCrossChecks": set(),
        }
        for key in ("authoritativeSources", "completeTableCrossChecks"):
            sources = audit.get(key)
            if not isinstance(sources, list) or not sources:
                errors.append(f"{year}: {key} must be non-empty")
                continue
            for source in sources:
                if not isinstance(source, dict):
                    errors.append(f"{year}: invalid {key} entry")
                    continue
                url = source.get("url")
                if not _https(url):
                    errors.append(f"{year}: {key} source must use HTTPS")
                else:
                    key_value = _url_key(url)
                    if key_value is not None:
                        source_urls[key].add(key_value)
                    if _is_self_source(url):
                        errors.append(f"{year}: active evidence must not self-reference linchun.com.cn: {url}")
                if source.get("grade") not in ALLOWED_GRADES:
                    errors.append(f"{year}: unsupported source grade {source.get('grade')!r}")
                if not isinstance(source.get("role"), str) or not source["role"].strip():
                    errors.append(f"{year}: source role must be documented")

        official_url = block.get("officialUrl")
        transcription_url = block.get("transcriptionUrl")
        if not _https(official_url):
            errors.append(f"{year}: rankings officialUrl must use HTTPS")
        elif _url_key(official_url) not in source_urls["authoritativeSources"]:
            errors.append(f"{year}: rankings officialUrl must be anchored in V4 authoritativeSources")
        if not _https(transcription_url):
            errors.append(f"{year}: rankings transcriptionUrl must use HTTPS")
        else:
            if _is_self_source(transcription_url):
                errors.append(f"{year}: rankings transcriptionUrl must not self-reference linchun.com.cn")
            if _url_key(transcription_url) not in source_urls["completeTableCrossChecks"]:
                errors.append(f"{year}: rankings transcriptionUrl must be anchored in V4 completeTableCrossChecks")

        if not isinstance(audit.get("aggregateChecks"), list) or not audit["aggregateChecks"]:
            errors.append(f"{year}: aggregateChecks must be non-empty")
        for key in ("anomalyChecks", "limitations"):
            if not isinstance(audit.get(key), list):
                errors.append(f"{year}: {key} must be an array")

    if scope.get("recordCount") != total_records:
        errors.append("verification scope.recordCount must match production records")

    rejected = verification.get("rejectedSources")
    if not isinstance(rejected, list):
        errors.append("rejectedSources must be an array")
    else:
        for source in rejected:
            if not isinstance(source, dict):
                errors.append("invalid rejectedSources entry")
                continue
            if source.get("rankingYear") not in manifest_years:
                errors.append("rejected source references unknown year")
            if not _https(source.get("url")):
                errors.append("rejected source must use HTTPS")
            if not isinstance(source.get("reason"), str) or not source["reason"].strip():
                errors.append("rejected source reason must be documented")

    conclusion = verification.get("conclusion")
    if not isinstance(conclusion, dict):
        errors.append("verification conclusion must be an object")
        conclusion = {}
    if conclusion.get("recordsReverified") != total_records:
        errors.append("conclusion.recordsReverified must match production records")
    if conclusion.get("yearsVerified") != len(manifest_years):
        errors.append("conclusion.yearsVerified must match production years")
    expected_legacy_gaps = sorted(
        year for year, item in audit_years.items()
        if item.get("status") == "verified_with_legacy_primary_gap"
    )
    if conclusion.get("legacyPrimaryGaps") != expected_legacy_gaps:
        errors.append("conclusion.legacyPrimaryGaps must match legacy-gap year statuses")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    args = parser.parse_args()
    errors = validate(args.data_dir)
    if errors:
        print("bank_rank evidence verification FAILED")
        for error in errors:
            print(f"- {error}")
        return 1
    verification = load_json(args.data_dir / VERIFICATION_FILE)
    print(
        f"bank_rank evidence verification OK: "
        f"{verification['conclusion']['recordsReverified']} records, "
        f"{verification['conclusion']['yearsVerified']} years, "
        f"{verification['auditVersion']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())