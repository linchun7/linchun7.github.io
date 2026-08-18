#!/usr/bin/env python3
"""One-time enrichment of 2011 original published hospital names as search aliases."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RANKINGS = ROOT / "data" / "rankings.json"
AUDIT = ROOT / "data" / "audit.json"
ORIGINAL_URL = "https://www.fdygs.com/news2011-2.aspx"

# Names shown on the Fudan Hospital Management Institute's original 2011 overall-ranking
# archive where they differ from the current Health界 historical page / current canonical name.
ORIGINAL_NAMES = {
    1: "北京协和医院",
    5: "第四军医大学西京医院",
    15: "第二军医大学长海医院",
    17: "中国医学科学院阜外心血管病医院",
    26: "第二军医大学长征医院",
    27: "上海交通大学医学院附属第六人民医院",
    31: "第三军医大学西南医院",
    41: "江苏省人民医院",
    42: "浙江医科大学附属第二医院",
    50: "中国人民解放军第三零二医院",
    54: "南京军区南京总医院",
    57: "第四军医大学口腔医院",
    58: "中国医学科学院血液学研究所",
    63: "天津医科大学附属肿瘤医院",
    65: "西安交通大学医学院第一附属医院",
    66: "山东省肿瘤医院",
    70: "第三军医大学新桥医院",
    71: "第四军医大学唐都医院",
    74: "上海交通大学医学院附属第一人民医院",
    78: "第三军医大学大坪医院",
    83: "西安交通大学医学院第二附属医院",
    85: "同济大学附属上海市肺科医院",
}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    rankings = load(RANKINGS)
    audit = load(AUDIT)
    hospitals = {hospital["id"]: hospital for hospital in rankings["hospitals"]}
    year = next(block for block in rankings["years"] if block["year"] == 2011)
    by_rank = {record["rank"]: record for record in year["records"]}

    enriched = []
    for rank, original_name in ORIGINAL_NAMES.items():
        record = by_rank.get(rank)
        if not record:
            raise AssertionError(f"2011 rank {rank} missing")
        hospital = hospitals[record["hospitalId"]]
        aliases = hospital.setdefault("aliases", [])
        already_known = original_name == hospital["name"] or original_name in aliases
        if not already_known:
            aliases.append(original_name)
            aliases.sort()
        enriched.append({
            "year": 2011,
            "rank": rank,
            "originalPublishedName": original_name,
            "currentHistoricalPageName": record["sourceName"],
            "canonicalName": hospital["name"],
            "hospitalId": hospital["id"],
            "addedToAliases": not already_known,
            "sourceUrl": ORIGINAL_URL,
        })

    audit["historicalAliasEnrichment"] = enriched
    audit["summary"]["historicalAliasCandidates2011"] = len(enriched)
    audit["summary"]["historicalAliasesAdded2011"] = sum(1 for item in enriched if item["addedToAliases"])
    dump(RANKINGS, rankings)
    dump(AUDIT, audit)
    print(json.dumps({
        "candidates": len(enriched),
        "added": audit["summary"]["historicalAliasesAdded2011"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
