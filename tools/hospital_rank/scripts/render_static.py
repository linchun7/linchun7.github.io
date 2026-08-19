#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "rankings.json"
INDEX_PATH = ROOT / "index.html"
STYLE_PATH = ROOT / "style.css"
SCRIPT_PATH = ROOT / "script.js"
RANKINGS_PATH = DATA_PATH
ROWS_START = "<!-- STATIC_LATEST_ROWS_START -->"
ROWS_END = "<!-- STATIC_LATEST_ROWS_END -->"
OPTIONS_START = "<!-- STATIC_YEAR_OPTIONS_START -->"
OPTIONS_END = "<!-- STATIC_YEAR_OPTIONS_END -->"
DISCLAIMER_HTML = (
    '<p><strong>榜单说明：</strong>有排名的年份按官方名次展示；'
    '等级年份按各医院最近一次可用的排名作同等级内参考排序。</p>'
)


def esc(value: object) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def load_data() -> dict:
    with DATA_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def latest_block(data: dict) -> dict:
    return max(data["years"], key=lambda block: int(block["year"]))


def build_history(data: dict) -> dict[str, list[dict]]:
    history: dict[str, list[dict]] = {}
    for block in data["years"]:
        year = int(block["year"])
        for record in block["records"]:
            item = dict(record)
            item["year"] = year
            history.setdefault(item["hospitalId"], []).append(item)
    for records in history.values():
        records.sort(key=lambda item: item["year"], reverse=True)
    return history


def previous_numeric_rank(history: dict[str, list[dict]], hospital_id: str, year: int) -> tuple[int, float]:
    for record in history.get(hospital_id, []):
        if record["year"] >= year:
            continue
        rank = record.get("rank")
        if isinstance(rank, (int, float)):
            return int(record["year"]), float(rank)
    return (0, math.inf)


def sorted_latest_records(data: dict, block: dict) -> list[dict]:
    history = build_history(data)
    grades = data.get("rankingModes", {}).get("grade", {}).get("grades", [])
    grade_order = {grade: index for index, grade in enumerate(grades)}
    year = int(block["year"])
    records = []
    for source_order, record in enumerate(block["records"]):
        item = dict(record)
        item["sourceOrder"] = source_order
        records.append(item)

    if block.get("rankingMode") == "grade":
        return sorted(
            records,
            key=lambda item: (
                grade_order.get(item.get("grade"), 999),
                previous_numeric_rank(history, item["hospitalId"], year)[1],
                item["sourceOrder"],
            ),
        )
    return sorted(records, key=lambda item: (float(item.get("rank") or math.inf), item["sourceOrder"]))


def render_rank_cell(record: dict) -> str:
    grade = record.get("grade")
    if grade:
        return f'<td><span class="grade-badge">{esc(grade)}</span></td>'
    rank = record.get("rank")
    value = "-" if rank is None else str(int(rank))
    return f'<td><span class="rank-value">{esc(value)}</span></td>'


def render_number_cell(value: object) -> str:
    if value is None:
        return '<td class="empty-value">-</td>'
    if isinstance(value, float):
        text = f"{value:.3f}".rstrip("0").rstrip(".")
    else:
        text = str(value)
    return f"<td>{esc(text)}</td>"


def render_rows(data: dict, block: dict) -> str:
    hospitals = {item["id"]: item for item in data["hospitals"]}
    year = int(block["year"])
    lines: list[str] = []
    for record in sorted_latest_records(data, block):
        hospital = hospitals[record["hospitalId"]]
        lines.extend([
            f'                        <tr class="data-row" data-hospital-id="{esc(record["hospitalId"])}" data-year="{year}" data-static-prerendered="true">',
            f"                            <td>{year}</td>",
            f"                            {render_rank_cell(record)}",
            "                            <td>",
            f'                                <span class="hospital-name static-hospital-name">{esc(hospital.get("name") or record.get("sourceName"))}</span>',
            "                            </td>",
            f"                            {render_number_cell(record.get('specialtyReputation'))}",
            f"                            {render_number_cell(record.get('researchAcademic'))}",
            f"                            {render_number_cell(record.get('overallScore'))}",
            f"                            <td>{esc(hospital.get('province') or '-')}</td>",
            f"                            <td>{esc(hospital.get('city') or '-')}</td>",
            "                        </tr>",
        ])
    return "\n".join(lines)


def render_options(data: dict, latest_year: int) -> str:
    years = sorted((int(block["year"]) for block in data["years"]), reverse=True)
    lines = []
    for year in years:
        selected = " selected" if year == latest_year else ""
        lines.append(f'                                <option value="{year}"{selected}>{year}年</option>')
    lines.append('                                <option value="">全部年份</option>')
    return "\n".join(lines)


def replace_between(text: str, start: str, end: str, content: str) -> str:
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S)
    replacement = f"{start}\n{content}\n                        {end}" if "ROWS" in start else f"{start}\n{content}\n                            {end}"
    if not pattern.search(text):
        raise SystemExit(f"missing static marker: {start}")
    return pattern.sub(replacement, text, count=1)


def replace_tag_text(text: str, element_id: str, value: str) -> str:
    pattern = re.compile(rf'(<[^>]+id="{re.escape(element_id)}"[^>]*>).*?(</[^>]+>)', re.S)
    if not pattern.search(text):
        raise SystemExit(f"missing element: {element_id}")
    return pattern.sub(lambda match: f"{match.group(1)}{esc(value)}{match.group(2)}", text, count=1)


def git_blob_short_hash(path: Path) -> str:
    content = path.read_bytes()
    header = f"blob {len(content)}\0".encode("ascii")
    return hashlib.sha1(header + content).hexdigest()[:8]


def asset_version() -> str:
    return f"{git_blob_short_hash(STYLE_PATH)}-{git_blob_short_hash(SCRIPT_PATH)}"


def rankings_version() -> str:
    return git_blob_short_hash(RANKINGS_PATH)


def replace_disclaimer(text: str) -> str:
    pattern = re.compile(r'(<div class="data-disclaimer">\s*)<p>.*?</p>(\s*</div>)', re.S)
    if not pattern.search(text):
        raise SystemExit("missing data disclaimer")
    return pattern.sub(lambda match: f"{match.group(1)}{DISCLAIMER_HTML}{match.group(2)}", text, count=1)


def render_index(source: str, data: dict) -> str:
    block = latest_block(data)
    year = int(block["year"])
    oldest = min(int(item["year"]) for item in data["years"])
    rows = sorted_latest_records(data, block)

    result = replace_between(source, ROWS_START, ROWS_END, render_rows(data, block))
    result = replace_between(result, OPTIONS_START, OPTIONS_END, render_options(data, year))
    result = replace_tag_text(result, "workspaceTitle", f"{year} 年医院榜单 · 共 {len(rows)} 家医院")
    result = replace_tag_text(result, "resultSummary", f"{year} 年 · 共 {len(rows)} 家医院")
    result = replace_tag_text(result, "brandSubtitle", f"中国医院综合排行榜 · {oldest}–{year}")
    result = replace_tag_text(result, "dataStatus", f"最新数据 {year} 年")
    result = replace_disclaimer(result)

    rank_label = "等级" if block.get("rankingMode") == "grade" else "排名"
    result = replace_tag_text(result, "rankColumnLabel", rank_label)
    result = re.sub(
        r'<html lang="zh-CN"(?: data-rankings-version="[^"]*")?>',
        f'<html lang="zh-CN" data-rankings-version="{rankings_version()}">',
        result,
        count=1,
    )

    version = asset_version()
    result = re.sub(
        r'href="style\.css(?:\?v=[^"]*)?"',
        f'href="style.css?v={version}"',
        result,
        count=1,
    )
    result = re.sub(
        r'src="script\.js(?:\?v=[^"]*)?"',
        f'src="script.js?v={version}"',
        result,
        count=1,
    )

    table_classes = "hospital-table single-year"
    if block.get("rankingMode") == "grade":
        table_classes += " grade-mode"
    result = re.sub(
        r'<table id="hospitalTable" class="[^"]*"',
        f'<table id="hospitalTable" class="{table_classes}"',
        result,
        count=1,
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Render latest hospital ranking into static HTML fallback")
    parser.add_argument("--check", action="store_true", help="fail when index.html is not up to date")
    args = parser.parse_args()

    data = load_data()
    source = INDEX_PATH.read_text(encoding="utf-8")
    rendered = render_index(source, data)

    if args.check:
        if rendered != source:
            raise SystemExit("hospital_rank/index.html static snapshot is stale; run render_static.py")
        print(json.dumps({
            "status": "ok",
            "latestYear": int(latest_block(data)["year"]),
            "staticRows": len(latest_block(data)["records"]),
            "assetVersion": asset_version(),
            "rankingsVersion": rankings_version(),
        }, ensure_ascii=False))
        return

    INDEX_PATH.write_text(rendered, encoding="utf-8")
    print(json.dumps({
        "status": "rendered",
        "latestYear": int(latest_block(data)["year"]),
        "staticRows": len(latest_block(data)["records"]),
        "assetVersion": asset_version(),
        "rankingsVersion": rankings_version(),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
