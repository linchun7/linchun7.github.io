#!/usr/bin/env python3
"""Fetch Fudan hospital ranking pages, audit legacy data.js, and build normalized JSON.

This script intentionally stores only structured data. Raw HTML is parsed in memory and
never written to disk. It uses only the Python standard library so the migration and
future manual verification stay lightweight.
"""

from __future__ import annotations

import argparse
import datetime as dt
import difflib
import hashlib
import html
import json
import math
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

START_YEAR = 2009
END_YEAR = 2023
SOURCE_URL_TEMPLATE = "https://rank.cn-healthcare.com/fudan/national-general/year/{year}"
GRADE_ORDER = ["A++++", "A+++", "A++", "A+", "A"]
GRADE_SET = set(GRADE_ORDER)
USER_AGENT = (
    "Mozilla/5.0 (compatible; linchun-hospital-rank-audit/1.0; "
    "+https://www.linchun.com.cn/tools/hospital_rank/)"
)


class RowParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._in_row = False
        self._in_cell = False
        self._cells: list[str] = []
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "tr":
            self._in_row = True
            self._cells = []
        elif self._in_row and tag in {"td", "th"}:
            self._in_cell = True
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._in_cell:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self._in_row and tag in {"td", "th"} and self._in_cell:
            text = " ".join("".join(self._parts).split())
            self._cells.append(html.unescape(text).strip())
            self._in_cell = False
            self._parts = []
        elif tag == "tr" and self._in_row:
            if self._cells:
                self.rows.append(self._cells)
            self._in_row = False
            self._cells = []


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = value.replace("暨", "")
    value = re.sub(r"[\s()（）\[\]【】{}·•,，。;；:：'\"“”‘’/\\\-—_]+", "", value)
    return value.lower()


def split_aliases(value: str) -> list[str]:
    if not value:
        return []
    parts = re.split(r"[;,；|]+", value)
    return [p.strip() for p in parts if p.strip()]


def parse_float(value: str) -> float | None:
    value = value.strip().replace(",", "")
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_int(value: str) -> int | None:
    value = value.strip().replace(",", "")
    match = re.search(r"\d+", value)
    return int(match.group()) if match else None


def fetch_html(url: str) -> str:
    last_error: Exception | None = None
    for attempt in range(3):
        req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,*/*"})
        try:
            with urlopen(req, timeout=30) as response:
                raw = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
                try:
                    return raw.decode(charset)
                except UnicodeDecodeError:
                    return raw.decode("utf-8", errors="replace")
        except (HTTPError, URLError, TimeoutError) as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last_error}")


def extract_source_year(year: int, page_html: str) -> dict[str, Any]:
    parser = RowParser()
    parser.feed(page_html)

    grade_records: list[dict[str, Any]] = []
    numeric_candidates: list[tuple[list[str], float, float, float]] = []

    for cells in parser.rows:
        if len(cells) >= 2 and cells[0].strip() in GRADE_SET and cells[1].strip():
            grade_records.append({
                "sourceName": cells[1].strip(),
                "grade": cells[0].strip(),
            })
            continue

        if len(cells) < 5:
            continue
        specialty = parse_float(cells[2])
        research = parse_float(cells[3])
        overall = parse_float(cells[4])
        hospital = cells[1].strip()
        if hospital and specialty is not None and research is not None and overall is not None:
            numeric_candidates.append((cells, specialty, research, overall))

    if grade_records:
        # Detail sections can repeat grade/name pairs. Keep the first contiguous official block.
        deduped: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for record in grade_records:
            key = (record["grade"], record["sourceName"])
            if key in seen:
                continue
            seen.add(key)
            deduped.append(record)
        grade_records = deduped
        counts = Counter(r["grade"] for r in grade_records)
        if year == 2023 and (len(grade_records) != 100 or any(counts[g] != 20 for g in GRADE_ORDER)):
            raise RuntimeError(f"{year}: unexpected grade table shape: total={len(grade_records)}, counts={dict(counts)}")
        return {
            "year": year,
            "rankingMode": "grade",
            "sourceUrl": SOURCE_URL_TEMPLATE.format(year=year),
            "records": grade_records,
        }

    if not numeric_candidates:
        raise RuntimeError(f"{year}: no ranking table found")

    records: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for position, (cells, specialty, research, overall) in enumerate(numeric_candidates, start=1):
        source_name = cells[1].strip()
        # The source renders the top three ranks as medal graphics; their text cells are blank.
        rank = parse_int(cells[0])
        if rank is None and position <= 3:
            rank = position
        if rank is None:
            continue
        if source_name in seen_names:
            # Ignore repeated hospital detail tables after the official ranking table.
            continue
        seen_names.add(source_name)
        records.append({
            "sourceName": source_name,
            "rank": rank,
            "specialtyReputation": specialty,
            "researchAcademic": research,
            "overallScore": overall,
        })

    if not records:
        raise RuntimeError(f"{year}: numeric table parsed but produced no records")
    if records[0]["rank"] != 1:
        raise RuntimeError(f"{year}: first rank is not 1")
    if any(records[i]["rank"] < records[i - 1]["rank"] for i in range(1, len(records))):
        raise RuntimeError(f"{year}: ranks are not monotonic")
    for record in records:
        if abs((record["specialtyReputation"] + record["researchAcademic"]) - record["overallScore"]) > 0.011:
            raise RuntimeError(f"{year}: score invariant failed for {record['sourceName']}")

    return {
        "year": year,
        "rankingMode": "numeric",
        "sourceUrl": SOURCE_URL_TEMPLATE.format(year=year),
        "records": records,
    }


def load_legacy(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end < start:
        raise RuntimeError(f"cannot locate JSON-like array in {path}")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, list):
        raise RuntimeError("legacy data is not a list")
    return data


class UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, value: int) -> int:
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, left: int, right: int) -> None:
        a, b = self.find(left), self.find(right)
        if a == b:
            return
        if self.rank[a] < self.rank[b]:
            a, b = b, a
        self.parent[b] = a
        if self.rank[a] == self.rank[b]:
            self.rank[a] += 1


def legacy_tokens(record: dict[str, Any]) -> list[str]:
    values = [record.get("医院名称", ""), *split_aliases(record.get("曾用名称", ""))]
    return [v for v in values if v]


def build_legacy_entities(legacy: list[dict[str, Any]]) -> tuple[UnionFind, dict[int, list[int]]]:
    uf = UnionFind(len(legacy))
    token_owner: dict[str, int] = {}
    for index, record in enumerate(legacy):
        for token in legacy_tokens(record):
            normalized = normalize_name(token)
            if not normalized:
                continue
            if normalized in token_owner:
                uf.union(index, token_owner[normalized])
            else:
                token_owner[normalized] = index
    components: dict[int, list[int]] = defaultdict(list)
    for index in range(len(legacy)):
        components[uf.find(index)].append(index)
    return uf, components


def choose_match(source_name: str, candidates: list[tuple[int, dict[str, Any]]]) -> tuple[int | None, str, float]:
    source_norm = normalize_name(source_name)
    exact: list[int] = []
    scored: list[tuple[float, int]] = []

    for index, record in candidates:
        token_norms = {normalize_name(token) for token in legacy_tokens(record)}
        if source_norm in token_norms:
            exact.append(index)
            continue
        best = max((difflib.SequenceMatcher(None, source_norm, token).ratio() for token in token_norms if token), default=0.0)
        scored.append((best, index))

    if len(exact) == 1:
        return exact[0], "exact", 1.0
    if len(exact) > 1:
        return exact[0], "exact-ambiguous", 1.0
    scored.sort(reverse=True)
    if scored:
        best_score, best_index = scored[0]
        second_score = scored[1][0] if len(scored) > 1 else 0.0
        if best_score >= 0.90 and best_score - second_score >= 0.06:
            return best_index, "fuzzy", best_score
    return None, "unmatched", scored[0][0] if scored else 0.0


def number_equal(a: Any, b: Any, tolerance: float = 1e-9) -> bool:
    try:
        return math.isclose(float(a), float(b), rel_tol=0.0, abs_tol=tolerance)
    except (TypeError, ValueError):
        return False


def build_outputs(source_years: list[dict[str, Any]], legacy: list[dict[str, Any]], retrieved_at: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    legacy_by_year: dict[int, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for index, record in enumerate(legacy):
        legacy_by_year[int(record["年份"])].append((index, record))

    uf, _ = build_legacy_entities(legacy)
    source_to_legacy: dict[tuple[int, str], int] = {}
    matched_legacy: set[int] = set()
    unmatched_source: list[dict[str, Any]] = []
    fuzzy_matches: list[dict[str, Any]] = []
    value_differences: list[dict[str, Any]] = []
    canonicalizations: list[dict[str, Any]] = []
    year_audit: list[dict[str, Any]] = []

    for year_block in source_years:
        year = int(year_block["year"])
        year_matched = 0
        year_unmatched = 0
        for source_record in year_block["records"]:
            source_name = source_record["sourceName"]
            match_index, method, score = choose_match(source_name, legacy_by_year.get(year, []))
            if match_index is None:
                year_unmatched += 1
                unmatched_source.append({"year": year, "sourceName": source_name, "bestScore": round(score, 4)})
                continue
            year_matched += 1
            matched_legacy.add(match_index)
            source_to_legacy[(year, source_name)] = match_index
            legacy_record = legacy[match_index]
            if method == "fuzzy":
                fuzzy_matches.append({
                    "year": year,
                    "sourceName": source_name,
                    "legacyName": legacy_record["医院名称"],
                    "score": round(score, 4),
                })
            if source_name != legacy_record["医院名称"]:
                canonicalizations.append({
                    "year": year,
                    "sourceName": source_name,
                    "canonicalName": legacy_record["医院名称"],
                })

            if year_block["rankingMode"] == "numeric":
                comparisons = [
                    ("rank", source_record["rank"], legacy_record.get("排名")),
                    ("specialtyReputation", source_record["specialtyReputation"], legacy_record.get("专科声誉")),
                    ("researchAcademic", source_record["researchAcademic"], legacy_record.get("科研学术")),
                    ("overallScore", source_record["overallScore"], legacy_record.get("综合得分")),
                ]
                for field, source_value, legacy_value in comparisons:
                    if not number_equal(source_value, legacy_value):
                        value_differences.append({
                            "year": year,
                            "sourceName": source_name,
                            "field": field,
                            "source": source_value,
                            "legacy": legacy_value,
                        })
            else:
                if str(legacy_record.get("排名", "")) != source_record["grade"]:
                    value_differences.append({
                        "year": year,
                        "sourceName": source_name,
                        "field": "grade",
                        "source": source_record["grade"],
                        "legacy": legacy_record.get("排名"),
                    })

        year_audit.append({
            "year": year,
            "rankingMode": year_block["rankingMode"],
            "sourceCount": len(year_block["records"]),
            "legacyCount": len(legacy_by_year.get(year, [])),
            "matchedCount": year_matched,
            "unmatchedSourceCount": year_unmatched,
        })

    unmatched_legacy = [
        {"year": int(record["年份"]), "hospital": record["医院名称"]}
        for index, record in enumerate(legacy)
        if START_YEAR <= int(record["年份"]) <= END_YEAR and index not in matched_legacy
    ]

    # Build entity components, including all legacy rows already connected through canonical/alias names.
    component_members: dict[int, list[int]] = defaultdict(list)
    for index in matched_legacy:
        component_members[uf.find(index)].append(index)

    entity_by_root: dict[int, dict[str, Any]] = {}
    id_collisions: dict[str, str] = {}
    location_conflicts: list[dict[str, Any]] = []

    for root, members in component_members.items():
        members.sort(key=lambda idx: (int(legacy[idx]["年份"]), idx))
        latest_index = max(members, key=lambda idx: (int(legacy[idx]["年份"]), idx))
        canonical_name = legacy[latest_index]["医院名称"]

        names: list[str] = []
        for idx in members:
            names.extend(legacy_tokens(legacy[idx]))
        for year_block in source_years:
            for source_record in year_block["records"]:
                idx = source_to_legacy.get((int(year_block["year"]), source_record["sourceName"]))
                if idx is not None and uf.find(idx) == root:
                    names.append(source_record["sourceName"])
        aliases = sorted({name for name in names if name and name != canonical_name})

        earliest_source_name = None
        for year_block in sorted(source_years, key=lambda block: int(block["year"])):
            for source_record in year_block["records"]:
                idx = source_to_legacy.get((int(year_block["year"]), source_record["sourceName"]))
                if idx is not None and uf.find(idx) == root:
                    earliest_source_name = source_record["sourceName"]
                    break
            if earliest_source_name:
                break
        stable_seed = normalize_name(earliest_source_name or canonical_name)
        hospital_id = "h_" + hashlib.sha1(stable_seed.encode("utf-8")).hexdigest()[:10]
        if hospital_id in id_collisions and id_collisions[hospital_id] != canonical_name:
            raise RuntimeError(f"hospital id collision: {canonical_name} and {id_collisions[hospital_id]}")
        id_collisions[hospital_id] = canonical_name

        province_values = [legacy[idx].get("省份", "") for idx in members if legacy[idx].get("省份")]
        city_values = [legacy[idx].get("城市", "") for idx in members if legacy[idx].get("城市")]
        province = legacy[latest_index].get("省份", "") or (Counter(province_values).most_common(1)[0][0] if province_values else "")
        city = legacy[latest_index].get("城市", "") or (Counter(city_values).most_common(1)[0][0] if city_values else "")
        if len(set(province_values)) > 1 or len(set(city_values)) > 1:
            location_conflicts.append({
                "hospital": canonical_name,
                "provinces": sorted(set(province_values)),
                "cities": sorted(set(city_values)),
                "selectedProvince": province,
                "selectedCity": city,
            })

        entity_by_root[root] = {
            "id": hospital_id,
            "name": canonical_name,
            "aliases": aliases,
            "province": province,
            "city": city,
        }

    hospitals = sorted(entity_by_root.values(), key=lambda item: item["name"])

    normalized_years: list[dict[str, Any]] = []
    for year_block in source_years:
        normalized_records: list[dict[str, Any]] = []
        for source_record in year_block["records"]:
            match_index = source_to_legacy.get((int(year_block["year"]), source_record["sourceName"]))
            if match_index is None:
                continue
            entity = entity_by_root[uf.find(match_index)]
            record: dict[str, Any] = {
                "hospitalId": entity["id"],
                "sourceName": source_record["sourceName"],
            }
            if year_block["rankingMode"] == "numeric":
                record.update({
                    "rank": source_record["rank"],
                    "grade": None,
                    "specialtyReputation": source_record["specialtyReputation"],
                    "researchAcademic": source_record["researchAcademic"],
                    "overallScore": source_record["overallScore"],
                })
            else:
                record.update({
                    "rank": None,
                    "grade": source_record["grade"],
                    "specialtyReputation": None,
                    "researchAcademic": None,
                    "overallScore": None,
                })
            normalized_records.append(record)
        normalized_years.append({
            "year": int(year_block["year"]),
            "rankingMode": year_block["rankingMode"],
            "records": normalized_records,
        })

    source_snapshot = {
        "schemaVersion": 1,
        "retrievedAt": retrieved_at,
        "source": {
            "publisher": "复旦大学医院管理研究所",
            "distribution": "健康界中国医院排行榜",
            "urlTemplate": SOURCE_URL_TEMPLATE,
            "rawHtmlStored": False,
        },
        "years": source_years,
    }

    rankings = {
        "schemaVersion": 1,
        "sourceRetrievedAt": retrieved_at,
        "source": {
            "publisher": "复旦大学医院管理研究所",
            "distribution": "健康界中国医院排行榜",
            "url": "https://rank.cn-healthcare.com/fudan/national-general",
        },
        "rankingModes": {
            "numeric": {"description": "数字排名", "fields": ["rank", "specialtyReputation", "researchAcademic", "overallScore"]},
            "grade": {"description": "等级制；同等级官方不分先后", "grades": GRADE_ORDER},
        },
        "hospitals": hospitals,
        "years": normalized_years,
    }

    audit_status = "ok" if not unmatched_source and not unmatched_legacy else "needs-review"
    audit = {
        "schemaVersion": 1,
        "generatedAt": retrieved_at,
        "status": audit_status,
        "summary": {
            "years": len(source_years),
            "sourceRecords": sum(len(block["records"]) for block in source_years),
            "legacyRecords": sum(1 for row in legacy if START_YEAR <= int(row["年份"]) <= END_YEAR),
            "hospitalEntities": len(hospitals),
            "canonicalizedSourceNames": len(canonicalizations),
            "fuzzyMatches": len(fuzzy_matches),
            "valueDifferences": len(value_differences),
            "unmatchedSource": len(unmatched_source),
            "unmatchedLegacy": len(unmatched_legacy),
            "locationConflicts": len(location_conflicts),
        },
        "years": year_audit,
        "canonicalizations": canonicalizations,
        "fuzzyMatches": fuzzy_matches,
        "valueDifferences": value_differences,
        "unmatchedSource": unmatched_source,
        "unmatchedLegacy": unmatched_legacy,
        "locationConflicts": location_conflicts,
    }
    return source_snapshot, rankings, audit


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy", type=Path, default=Path(__file__).resolve().parents[1] / "data.js")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--strict", action="store_true", help="exit non-zero when source/legacy matching is incomplete")
    args = parser.parse_args()

    legacy = load_legacy(args.legacy)
    retrieved_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    source_years: list[dict[str, Any]] = []
    for year in range(START_YEAR, END_YEAR + 1):
        url = SOURCE_URL_TEMPLATE.format(year=year)
        print(f"fetching {year}: {url}", flush=True)
        page = fetch_html(url)
        year_block = extract_source_year(year, page)
        print(f"  parsed {len(year_block['records'])} {year_block['rankingMode']} records", flush=True)
        source_years.append(year_block)

    source_snapshot, rankings, audit = build_outputs(source_years, legacy, retrieved_at)
    write_json(args.output_dir / "source-snapshot.json", source_snapshot)
    write_json(args.output_dir / "candidate-rankings.json", rankings)
    write_json(args.output_dir / "audit.json", audit)

    print(json.dumps(audit["summary"], ensure_ascii=False, indent=2))
    if args.strict and audit["status"] != "ok":
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
