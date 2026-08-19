#!/usr/bin/env python3
"""Render latest-year metadata and top-20 no-JS preview into index.html."""
from __future__ import annotations
import argparse, hashlib, html, importlib.util, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML_PATH = ROOT / "index.html"
SPEC = importlib.util.spec_from_file_location("validate_data", ROOT / "scripts" / "validate_data.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)
YEAR_START = "                            <!-- STATIC_YEAR_OPTIONS_START -->"
YEAR_END = "                            <!-- STATIC_YEAR_OPTIONS_END -->"
ROWS_START = "                        <!-- STATIC_LATEST_ROWS_START -->"
ROWS_END = "                        <!-- STATIC_LATEST_ROWS_END -->"


def replace_marker_block(text: str, start: str, end: str, content: str) -> str:
    updated, count = re.subn(re.escape(start) + r".*?" + re.escape(end), lambda _: f"{start}\n{content}\n{end}", text, count=1, flags=re.S)
    if count != 1: raise RuntimeError(f"marker block not found exactly once: {start}")
    return updated


def previous_record(data: dict, bank_id: str, before_year: int) -> dict | None:
    for block in sorted(data["years"], key=lambda x: x["rankingYear"], reverse=True):
        if block["rankingYear"] >= before_year: continue
        for record in block["records"]:
            if record["bankId"] == bank_id: return record
    return None


def rank_change(record: dict, previous: dict | None) -> tuple[str, str]:
    if previous is None: return "首次记录", "new"
    delta = previous["rank"] - record["rank"]
    if delta > 0: return f"↑ {delta} 位", "up"
    if delta < 0: return f"↓ {abs(delta)} 位", "down"
    return "— 持平", "same"


def render(data: dict, current_html: str) -> str:
    latest = max(data["years"], key=lambda block: block["rankingYear"])
    latest_year = latest["rankingYear"]
    oldest_year = min(block["rankingYear"] for block in data["years"])
    total_records = sum(len(block["records"]) for block in data["years"])
    bank_by_id = {bank["id"]: bank for bank in data["banks"]}
    version = hashlib.sha256((ROOT / "data" / "rankings.json").read_bytes()).hexdigest()[:10]
    options = "\n".join(f'                            <option value="{year}"{" selected" if year == latest_year else ""}>{year}年</option>' for year in sorted((b["rankingYear"] for b in data["years"]), reverse=True))
    rows = []
    for record in latest["records"][:20]:
        bank = bank_by_id[record["bankId"]]
        change, change_class = rank_change(record, previous_record(data, record["bankId"], latest_year))
        rows.append(
            f'                        <tr class="data-row" data-bank-id="{html.escape(record["bankId"])}" data-static-prerendered="true">'
            f'<td><span class="rank-value">{record["rank"]}</span></td>'
            f'<td><span class="bank-name">{html.escape(bank["name"])}</span></td>'
            f'<td><span class="type-badge">{html.escape(bank["type"])}</span></td>'
            f'<td>{record["coreTier1Capital"]:,.2f}</td><td>{record["assets"]:,.2f}</td><td>{record["netProfit"]:,.2f}</td>'
            f'<td><span class="change {change_class}">{change}</span></td></tr>'
        )
    text = re.sub(r'data-latest-year="\d+"', f'data-latest-year="{latest_year}"', current_html, count=1)
    text = re.sub(r'data-rankings-version="[^"]*"', f'data-rankings-version="{version}"', text, count=1)
    text = replace_marker_block(text, YEAR_START, YEAR_END, options)
    text = replace_marker_block(text, ROWS_START, ROWS_END, "\n".join(rows))
    text = re.sub(r'<p id="brandSubtitle">.*?</p>', f'<p id="brandSubtitle">中国银行业协会 · {oldest_year}–{latest_year}</p>', text, count=1)
    scope = (
        '<section class="scope-note" aria-label="数据范围说明">\n'
        f'      <strong>数据范围：</strong>当前已完成 {oldest_year}–{latest_year} 共 {len(data["years"])} 个年度、{total_records} 条榜单记录的结构化核验。'
        f'榜单年度对应上一年末数据，例如 {latest_year} 年榜单使用 {latest["dataYear"]} 年末数据。\n'
        '    </section>'
    )
    text, count = re.subn(r'<section class="scope-note" aria-label="数据范围说明">.*?</section>', scope, text, count=1, flags=re.S)
    if count != 1: raise RuntimeError("data scope section not found exactly once")
    text = re.sub(r'<h1 id="workspaceTitle">.*?</h1>', f'<h1 id="workspaceTitle">{latest_year} 年中国银行业100强 · {len(latest["records"])} 家</h1>', text, count=1)
    text = re.sub(r'<p id="resultSummary">.*?</p>', f'<p id="resultSummary">数据口径：{latest["dataYear"]} 年末</p>', text, count=1)
    text = re.sub(r'<div class="data-status" id="dataStatus" aria-live="polite">.*?</div>', f'<div class="data-status" id="dataStatus" aria-live="polite">最新数据 {latest_year} 年</div>', text, count=1)
    source = re.compile(r'(<a class="source-link" id="officialSource" href=")[^"]*("[^>]*>).*?(</a>)')
    text, count = source.subn(lambda m: f'{m.group(1)}{html.escape(latest["officialUrl"], quote=True)}{m.group(2)}{latest_year} 年中国银行业协会官方发布页{m.group(3)}', text, count=1)
    if count != 1: raise RuntimeError("official source link not found exactly once")
    return text


def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--check", action="store_true"); args = parser.parse_args()
    data = MODULE.load_rankings(); current = HTML_PATH.read_text(encoding="utf-8"); expected = render(data, current)
    if args.check:
        if current != expected: print("index.html static preview is stale"); return 1
        print("index.html static preview is up to date"); return 0
    HTML_PATH.write_text(expected, encoding="utf-8"); print(f"rendered latest year {max(b['rankingYear'] for b in data['years'])}"); return 0


if __name__ == "__main__": raise SystemExit(main())
