#!/usr/bin/env python3
"""Render latest-year metadata, resource versions and top-20 no-JS preview."""
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


def resource_version(path: Path) -> str:
    raw = path.read_bytes()
    blob = b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw
    return hashlib.sha1(blob).hexdigest()[:8]


def previous_record(data: dict, bank_id: str, before_year: int) -> dict | None:
    target_year = before_year - 1
    for block in data["years"]:
        if block["rankingYear"] != target_year: continue
        for record in block["records"]:
            if record["bankId"] == bank_id: return record
    return None


def has_earlier_record(data: dict, bank_id: str, before_year: int) -> bool:
    return any(
        record["bankId"] == bank_id
        for block in data["years"] if block["rankingYear"] < before_year
        for record in block["records"]
    )


def rank_change(record: dict, previous: dict | None, has_earlier: bool = False) -> tuple[str, str]:
    if previous is None: return ("上年未上榜" if has_earlier else "首次记录"), "new"
    delta = previous["rank"] - record["rank"]
    if delta > 0: return f"↑ {delta} 位", "up"
    if delta < 0: return f"↓ {abs(delta)} 位", "down"
    return "— 持平", "same"


def render(data: dict, current_html: str) -> str:
    latest = max(data["years"], key=lambda block: block["rankingYear"])
    latest_year = latest["rankingYear"]
    oldest_year = min(block["rankingYear"] for block in data["years"])
    bank_by_id = {bank["id"]: bank for bank in data["banks"]}
    rankings_version = hashlib.sha256((ROOT / "data" / "rankings.json").read_bytes()).hexdigest()[:10]
    style_version = resource_version(ROOT / "style.css")
    script_version = resource_version(ROOT / "script.js")
    options = "\n".join(f'                            <option value="{year}"{" selected" if year == latest_year else ""}>{year}年</option>' for year in sorted((b["rankingYear"] for b in data["years"]), reverse=True))
    rows = []
    for record in latest["records"][:20]:
        bank = bank_by_id[record["bankId"]]
        change, change_class = rank_change(
            record,
            previous_record(data, record["bankId"], latest_year),
            has_earlier_record(data, record["bankId"], latest_year),
        )
        rows.append(
            f'                        <tr class="data-row" data-bank-id="{html.escape(record["bankId"])}" data-static-prerendered="true">'
            f'<td><span class="rank-value">{record["rank"]}</span></td>'
            f'<td><span class="bank-name">{html.escape(record["sourceName"])}</span></td>'
            f'<td><span class="type-badge">{html.escape(bank["type"])}</span></td>'
            f'<td>{record["coreTier1Capital"]:,.2f}</td><td>{record["assets"]:,.2f}</td><td>{record["netProfit"]:,.2f}</td>'
            f'<td><span class="change {change_class}">{change}</span></td></tr>'
        )
    text = re.sub(r'data-latest-year="\d+"', f'data-latest-year="{latest_year}"', current_html, count=1)
    text = re.sub(r'data-rankings-version="[^"]*"', f'data-rankings-version="{rankings_version}"', text, count=1)
    text = replace_marker_block(text, YEAR_START, YEAR_END, options)
    text = replace_marker_block(text, ROWS_START, ROWS_END, "\n".join(rows))
    text = re.sub(r'<p id="brandSubtitle">.*?</p>', f'<p id="brandSubtitle">核心一级资本排名 · {oldest_year}–{latest_year}</p>', text, count=1)
    text = re.sub(r'<h1 id="workspaceTitle">.*?</h1>', f'<h1 id="workspaceTitle">{latest_year} 年中国银行业100强</h1>', text, count=1)
    text = re.sub(r'<p id="resultSummary">.*?</p>', f'<p id="resultSummary">{len(latest["records"])} 家银行 · {latest["dataYear"]} 年末数据</p>', text, count=1)
    text = re.sub(r'<div class="data-status" id="dataStatus" aria-live="polite">.*?</div>', f'<div class="data-status" id="dataStatus" aria-live="polite">最新数据 {latest_year} 年</div>', text, count=1)
    text, count = re.subn(r'<link rel="stylesheet" href="style\.css(?:\?v=[^"]*)?">', f'<link rel="stylesheet" href="style.css?v={style_version}">', text, count=1)
    if count != 1: raise RuntimeError("stylesheet link not found exactly once")
    text, count = re.subn(r'<script src="script\.js(?:\?v=[^"]*)?" defer></script>', f'<script src="script.js?v={script_version}" defer></script>', text, count=1)
    if count != 1: raise RuntimeError("script tag not found exactly once")
    if re.search(r'class="scope-note"|id="officialSource"|id="yearNote"', text):
        raise RuntimeError("deprecated scope/source UI remains in index.html")
    return text


def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--check", action="store_true"); args = parser.parse_args()
    data = MODULE.load_rankings(); current = HTML_PATH.read_text(encoding="utf-8"); expected = render(data, current)
    if args.check:
        if current != expected: print("index.html static preview is stale"); return 1
        print("index.html static preview is up to date"); return 0
    HTML_PATH.write_text(expected, encoding="utf-8"); print(f"rendered latest year {max(b['rankingYear'] for b in data['years'])}"); return 0


if __name__ == "__main__": raise SystemExit(main())
