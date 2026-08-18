#!/usr/bin/env python3
"""Build normalized hospital ranking JSON from the public Fudan ranking pages.

Raw HTML is fetched and parsed in memory only. The repository stores structured JSON,
not page archives. Existing data.js is used only as the migration-time source of local
metadata (canonical names, aliases, province and city) and as an independent data set
for field-by-field verification.
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
URL_TEMPLATE = "https://rank.cn-healthcare.com/fudan/national-general/year/{year}"
GRADE_ORDER = ["A++++", "A+++", "A++", "A+", "A"]
EXPECTED_COUNTS = {2009: 50, 2010: 80, **{year: 100 for year in range(2011, 2024)}}
UA = "Mozilla/5.0 (compatible; linchun-hospital-rank-audit/1.0; +https://www.linchun.com.cn/tools/hospital_rank/)"


class TableRows(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self.in_row = False
        self.in_cell = False
        self.cells: list[str] = []
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "tr":
            self.in_row = True
            self.cells = []
        elif self.in_row and tag in {"td", "th"}:
            self.in_cell = True
            self.parts = []

    def handle_data(self, data: str) -> None:
        if self.in_cell:
            self.parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.in_row and self.in_cell and tag in {"td", "th"}:
            value = html.unescape(" ".join("".join(self.parts).split())).strip()
            self.cells.append(value)
            self.in_cell = False
            self.parts = []
        elif self.in_row and tag == "tr":
            if self.cells:
                self.rows.append(self.cells)
            self.in_row = False
            self.cells = []


def norm_name(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = re.sub(r"[\s()（）\[\]【】{}·•,，。;；:：'\"“”‘’/\\\-—_]+", "", value)
    return value.lower()


def aliases(value: str) -> list[str]:
    return [part.strip() for part in re.split(r"[;,；、|]+", value or "") if part.strip()]


def legacy_names(row: dict[str, Any]) -> list[str]:
    return [name for name in [row.get("医院名称", ""), *aliases(row.get("曾用名称", ""))] if name]


def as_float(value: str) -> float | None:
    try:
        return float(value.strip().replace(",", "")) if value.strip() else None
    except ValueError:
        return None


def as_int(value: str) -> int | None:
    match = re.search(r"\d+", value or "")
    return int(match.group()) if match else None


def fetch(url: str) -> str:
    last: Exception | None = None
    for attempt in range(3):
        try:
            request = Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
            with urlopen(request, timeout=30) as response:
                raw = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
                try:
                    return raw.decode(charset)
                except UnicodeDecodeError:
                    return raw.decode("utf-8", errors="replace")
        except (HTTPError, URLError, TimeoutError) as exc:
            last = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"fetch failed: {url}: {last}")


def parse_year(year: int, page: str) -> dict[str, Any]:
    parser = TableRows()
    parser.feed(page)
    warnings: list[dict[str, Any]] = []

    grade_rows: list[dict[str, Any]] = []
    numeric_rows: list[tuple[list[str], float, float, float]] = []
    for cells in parser.rows:
        if len(cells) >= 2 and cells[0].strip() in GRADE_ORDER and cells[1].strip():
            grade_rows.append({"sourceName": cells[1].strip(), "grade": cells[0].strip()})
            continue
        if len(cells) < 5:
            continue
        specialty, research, overall = as_float(cells[2]), as_float(cells[3]), as_float(cells[4])
        if cells[1].strip() and specialty is not None and research is not None and overall is not None:
            numeric_rows.append((cells, specialty, research, overall))

    if grade_rows:
        unique: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for row in grade_rows:
            key = (row["grade"], row["sourceName"])
            if key not in seen:
                seen.add(key)
                unique.append(row)
        records = unique
        mode = "grade"
        if year == 2023:
            counts = Counter(row["grade"] for row in records)
            if any(counts[grade] != 20 for grade in GRADE_ORDER):
                warnings.append({"type": "grade-count", "counts": dict(counts)})
    else:
        records = []
        seen_names: set[str] = set()
        for position, (cells, specialty, research, overall) in enumerate(numeric_rows, start=1):
            name = cells[1].strip()
            if name in seen_names:
                continue
            rank = as_int(cells[0])
            if rank is None and position <= 3:
                rank = position  # top three are rendered as medal graphics on the source site
            if rank is None:
                continue
            seen_names.add(name)
            delta = round(overall - (specialty + research), 6)
            if abs(delta) > 0.011:
                warnings.append({
                    "type": "score-sum",
                    "sourceName": name,
                    "rank": rank,
                    "specialtyReputation": specialty,
                    "researchAcademic": research,
                    "overallScore": overall,
                    "delta": delta,
                })
            records.append({
                "sourceName": name,
                "rank": rank,
                "specialtyReputation": specialty,
                "researchAcademic": research,
                "overallScore": overall,
            })
        mode = "numeric"
        if records and any(records[i]["rank"] < records[i - 1]["rank"] for i in range(1, len(records))):
            raise RuntimeError(f"{year}: non-monotonic rank table")

    expected = EXPECTED_COUNTS[year]
    if len(records) != expected:
        raise RuntimeError(f"{year}: expected {expected} records, got {len(records)}")
    if len({row["sourceName"] for row in records}) != len(records):
        raise RuntimeError(f"{year}: duplicate source hospital names")

    return {
        "year": year,
        "rankingMode": mode,
        "sourceUrl": URL_TEMPLATE.format(year=year),
        "records": records,
        "validationWarnings": warnings,
    }


def load_legacy(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        raise RuntimeError("legacy data.js does not contain an array")
    value = json.loads(text[start : end + 1])
    if not isinstance(value, list):
        raise RuntimeError("legacy data is not a list")
    return value


class UF:
    def __init__(self, n: int) -> None:
        self.p = list(range(n))

    def find(self, x: int) -> int:
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a: int, b: int) -> None:
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[b] = a


def build_components(legacy: list[dict[str, Any]]) -> UF:
    uf = UF(len(legacy))
    owner: dict[str, int] = {}
    for i, row in enumerate(legacy):
        for name in legacy_names(row):
            token = norm_name(name)
            if not token:
                continue
            if token in owner:
                uf.union(i, owner[token])
            else:
                owner[token] = i
    return uf


def match_name(name: str, candidates: list[tuple[int, dict[str, Any]]]) -> tuple[int | None, str, float]:
    source = norm_name(name)
    exact: list[int] = []
    scores: list[tuple[float, int]] = []
    for idx, row in candidates:
        tokens = {norm_name(item) for item in legacy_names(row) if item}
        if source in tokens:
            exact.append(idx)
        else:
            score = max((difflib.SequenceMatcher(None, source, token).ratio() for token in tokens), default=0.0)
            scores.append((score, idx))
    if exact:
        return exact[0], "exact" if len(exact) == 1 else "exact-ambiguous", 1.0
    scores.sort(reverse=True)
    if scores:
        best, idx = scores[0]
        second = scores[1][0] if len(scores) > 1 else 0.0
        if best >= 0.90 and best - second >= 0.06:
            return idx, "fuzzy", best
        return None, "unmatched", best
    return None, "unmatched", 0.0


def num_eq(a: Any, b: Any) -> bool:
    try:
        return math.isclose(float(a), float(b), rel_tol=0.0, abs_tol=1e-9)
    except (TypeError, ValueError):
        return False


def migrate(source_years: list[dict[str, Any]], legacy: list[dict[str, Any]], retrieved: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    by_year: dict[int, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for idx, row in enumerate(legacy):
        by_year[int(row["年份"])].append((idx, row))

    uf = build_components(legacy)
    matches: dict[tuple[int, str], int] = {}
    matched_legacy: set[int] = set()
    unmatched_source: list[dict[str, Any]] = []
    fuzzy: list[dict[str, Any]] = []
    canonicalizations: list[dict[str, Any]] = []
    value_diffs: list[dict[str, Any]] = []
    year_report: list[dict[str, Any]] = []

    for block in source_years:
        year = block["year"]
        matched = 0
        for src in block["records"]:
            idx, method, score = match_name(src["sourceName"], by_year.get(year, []))
            if idx is None:
                unmatched_source.append({"year": year, "sourceName": src["sourceName"], "bestScore": round(score, 4)})
                continue
            matches[(year, src["sourceName"])] = idx
            matched_legacy.add(idx)
            matched += 1
            old = legacy[idx]
            if method == "fuzzy":
                fuzzy.append({"year": year, "sourceName": src["sourceName"], "legacyName": old["医院名称"], "score": round(score, 4)})
            if src["sourceName"] != old["医院名称"]:
                canonicalizations.append({"year": year, "sourceName": src["sourceName"], "canonicalName": old["医院名称"]})

            checks = [("grade", src.get("grade"), old.get("排名"))] if block["rankingMode"] == "grade" else [
                ("rank", src.get("rank"), old.get("排名")),
                ("specialtyReputation", src.get("specialtyReputation"), old.get("专科声誉")),
                ("researchAcademic", src.get("researchAcademic"), old.get("科研学术")),
                ("overallScore", src.get("overallScore"), old.get("综合得分")),
            ]
            for field, live, legacy_value in checks:
                equal = str(live) == str(legacy_value) if field == "grade" else num_eq(live, legacy_value)
                if not equal:
                    value_diffs.append({"year": year, "sourceName": src["sourceName"], "field": field, "source": live, "legacy": legacy_value})

        year_report.append({
            "year": year,
            "rankingMode": block["rankingMode"],
            "sourceCount": len(block["records"]),
            "legacyCount": len(by_year.get(year, [])),
            "matchedCount": matched,
            "unmatchedSourceCount": len(block["records"]) - matched,
            "sourceWarningCount": len(block["validationWarnings"]),
        })

    unmatched_legacy = [
        {"year": int(row["年份"]), "hospital": row["医院名称"]}
        for idx, row in enumerate(legacy)
        if START_YEAR <= int(row["年份"]) <= END_YEAR and idx not in matched_legacy
    ]

    components: dict[int, list[int]] = defaultdict(list)
    for idx in matched_legacy:
        components[uf.find(idx)].append(idx)

    entities_by_root: dict[int, dict[str, Any]] = {}
    location_conflicts: list[dict[str, Any]] = []
    ids: dict[str, str] = {}

    for root, members in components.items():
        members.sort(key=lambda idx: (int(legacy[idx]["年份"]), idx))
        latest = members[-1]
        canonical = legacy[latest]["医院名称"]

        source_names: list[tuple[int, str]] = []
        for block in source_years:
            for src in block["records"]:
                idx = matches.get((block["year"], src["sourceName"]))
                if idx is not None and uf.find(idx) == root:
                    source_names.append((block["year"], src["sourceName"]))
        source_names.sort()
        seed = norm_name(source_names[0][1] if source_names else canonical)
        hospital_id = "h_" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10]
        if hospital_id in ids and ids[hospital_id] != canonical:
            raise RuntimeError(f"hospital id collision: {canonical} / {ids[hospital_id]}")
        ids[hospital_id] = canonical

        all_names: set[str] = set()
        for idx in members:
            all_names.update(legacy_names(legacy[idx]))
        all_names.update(name for _, name in source_names)

        provinces = [legacy[idx].get("省份", "") for idx in members if legacy[idx].get("省份")]
        cities = [legacy[idx].get("城市", "") for idx in members if legacy[idx].get("城市")]
        province = legacy[latest].get("省份", "") or (Counter(provinces).most_common(1)[0][0] if provinces else "")
        city = legacy[latest].get("城市", "") or (Counter(cities).most_common(1)[0][0] if cities else "")
        if len(set(provinces)) > 1 or len(set(cities)) > 1:
            location_conflicts.append({
                "hospital": canonical,
                "provinces": sorted(set(provinces)),
                "cities": sorted(set(cities)),
                "selectedProvince": province,
                "selectedCity": city,
            })

        entities_by_root[root] = {
            "id": hospital_id,
            "name": canonical,
            "aliases": sorted(name for name in all_names if name and name != canonical),
            "province": province,
            "city": city,
        }

    years: list[dict[str, Any]] = []
    for block in source_years:
        rows: list[dict[str, Any]] = []
        for src in block["records"]:
            idx = matches.get((block["year"], src["sourceName"]))
            if idx is None:
                continue
            entity = entities_by_root[uf.find(idx)]
            row = {"hospitalId": entity["id"], "sourceName": src["sourceName"]}
            if block["rankingMode"] == "numeric":
                row.update({
                    "rank": src["rank"], "grade": None,
                    "specialtyReputation": src["specialtyReputation"],
                    "researchAcademic": src["researchAcademic"],
                    "overallScore": src["overallScore"],
                })
            else:
                row.update({"rank": None, "grade": src["grade"], "specialtyReputation": None, "researchAcademic": None, "overallScore": None})
            rows.append(row)
        years.append({"year": block["year"], "rankingMode": block["rankingMode"], "records": rows})

    snapshot = {
        "schemaVersion": 1,
        "retrievedAt": retrieved,
        "source": {
            "publisher": "复旦大学医院管理研究所",
            "distribution": "健康界中国医院排行榜",
            "urlTemplate": URL_TEMPLATE,
            "rawHtmlStored": False,
        },
        "years": source_years,
    }
    rankings = {
        "schemaVersion": 1,
        "sourceRetrievedAt": retrieved,
        "source": {
            "publisher": "复旦大学医院管理研究所",
            "distribution": "健康界中国医院排行榜",
            "url": "https://rank.cn-healthcare.com/fudan/national-general",
        },
        "rankingModes": {
            "numeric": {"description": "数字排名", "fields": ["rank", "specialtyReputation", "researchAcademic", "overallScore"]},
            "grade": {"description": "等级制；同等级官方不分先后", "grades": GRADE_ORDER},
        },
        "hospitals": sorted(entities_by_root.values(), key=lambda item: item["name"]),
        "years": years,
    }
    source_warnings = [
        {"year": block["year"], **warning}
        for block in source_years
        for warning in block["validationWarnings"]
    ]
    status = "ok" if not unmatched_source and not unmatched_legacy else "needs-review"
    audit = {
        "schemaVersion": 1,
        "generatedAt": retrieved,
        "status": status,
        "summary": {
            "years": len(source_years),
            "sourceRecords": sum(len(block["records"]) for block in source_years),
            "legacyRecords": sum(1 for row in legacy if START_YEAR <= int(row["年份"]) <= END_YEAR),
            "hospitalEntities": len(entities_by_root),
            "canonicalizedSourceNames": len(canonicalizations),
            "fuzzyMatches": len(fuzzy),
            "valueDifferences": len(value_diffs),
            "unmatchedSource": len(unmatched_source),
            "unmatchedLegacy": len(unmatched_legacy),
            "sourceValidationWarnings": len(source_warnings),
            "locationConflicts": len(location_conflicts),
        },
        "years": year_report,
        "sourceValidationWarnings": source_warnings,
        "canonicalizations": canonicalizations,
        "fuzzyMatches": fuzzy,
        "valueDifferences": value_diffs,
        "unmatchedSource": unmatched_source,
        "unmatchedLegacy": unmatched_legacy,
        "locationConflicts": location_conflicts,
    }
    return snapshot, rankings, audit


def dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--legacy", type=Path, default=Path(__file__).resolve().parents[1] / "data.js")
    ap.add_argument("--output-dir", type=Path, required=True)
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args()

    legacy = load_legacy(args.legacy)
    retrieved = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    source_years: list[dict[str, Any]] = []
    for year in range(START_YEAR, END_YEAR + 1):
        url = URL_TEMPLATE.format(year=year)
        print(f"fetching {year}: {url}", flush=True)
        block = parse_year(year, fetch(url))
        print(f"  parsed {len(block['records'])} {block['rankingMode']} records, warnings={len(block['validationWarnings'])}", flush=True)
        source_years.append(block)

    snapshot, rankings, audit = migrate(source_years, legacy, retrieved)
    dump(args.output_dir / "source-snapshot.json", snapshot)
    dump(args.output_dir / "candidate-rankings.json", rankings)
    dump(args.output_dir / "audit.json", audit)
    print(json.dumps(audit["summary"], ensure_ascii=False, indent=2), flush=True)
    return 2 if args.strict and audit["status"] != "ok" else 0


if __name__ == "__main__":
    sys.exit(main())
