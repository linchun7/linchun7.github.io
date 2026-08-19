#!/usr/bin/env python3
"""Render the latest bank ranking into index.html as a no-JS/SEO fallback."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "rankings.json"
HTML_PATH = ROOT / "index.html"

YEAR_START = "                            <!-- STATIC_YEAR_OPTIONS_START -->"
YEAR_END = "                            <!-- STATIC_YEAR_OPTIONS_END -->"
ROWS_START = "                        <!-- STATIC_LATEST_ROWS_START -->"
ROWS_END = "                        <!-- STATIC_LATEST_ROWS_END -->"


def load_data() -> dict:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def replace_marker_block(text: str, start: str, end: str, content: str) -> str:
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S)
    replacement = f"{start}\n{content}\n{end}"
    updated, count = pattern.subn(replacement, text, count=1)
    if count != 1:
        raise RuntimeError(f"marker block not found exactly once: {start}")
    return updated


def previous_record(data: dict, bank_id: str, before_year: int) -> dict | None:
    for block in sorted(data["years"], key=lambda x: x["rankingYear"], reverse=True):
        if block["rankingYear"] >= before_year:
            continue
        for record in block["records"]:
            if record["bankId"] == bank_id:
                return record
    return None


def rank_change(record: dict, previous: dict | None) -> tuple[str, str]:
    if previous is None:
        return "首次记录", "new"
    delta = previous["rank"] - record["rank"]
    if delta > 0:
        return f"↑ {delta} 位", "up"
    if delta < 0:
        return f"↓ {abs(delta)} 位", "down"
    return "— 持平", "same"


def render_year_options(data: dict, latest_year: int) -> str:
    return "\n".join(
        f'                            <option value="{year}"'
        f'{" selected" if year == latest_year else ""}>{year}年</option>'
        for year in sorted((b["rankingYear"] for b in data["years"]), reverse=True)
    )


def render_rows(data: dict, latest: dict) -> str:
    bank_by_id = {bank["id"]: bank for bank in data["banks"]}
    rows: list[str] = []
    for record in latest["records"]:
        bank = bank_by_id[record["bankId"]]
        change, change_class = rank_change(
            record, previous_record(data, record["bankId"], latest["rankingYear"])
        )
        rows.append(
            f'''                        <tr class="data-row" data-bank-id="{html.escape(record["bankId"])}" data-static-prerendered="true">
                            <td><span class="rank-value">{record["rank"]}</span></td>
                            <td><span class="bank-name">{html.escape(bank["name"])}</span></td>
                            <td><span class="type-badge">{html.escape(bank["type"])}</span></td>
                            <td>{record["coreTier1Capital"]:,.2f}</td>
                            <td>{record["assets"]:,.2f}</td>
                            <td>{record["netProfit"]:,.2f}</td>
                            <td><span class="change {change_class}">{change}</span></td>
                        </tr>'''
        )
    return "\n".join(rows)


def render(data: dict, current_html: str) -> str:
    latest = max(data["years"], key=lambda block: block["rankingYear"])
    latest_year = latest["rankingYear"]
    version = hashlib.sha256(DATA_PATH.read_bytes()).hexdigest()[:10]

    text = re.sub(
        r'data-latest-year="\d+"',
        f'data-latest-year="{latest_year}"',
        current_html,
        count=1,
    )
    text = re.sub(
        r'data-rankings-version="[^"]*"',
        f'data-rankings-version="{version}"',
        text,
        count=1,
    )
    text = replace_marker_block(
        text, YEAR_START, YEAR_END, render_year_options(data, latest_year)
    )
    text = replace_marker_block(text, ROWS_START, ROWS_END, render_rows(data, latest))
    text = re.sub(
        r'<h1 id="workspaceTitle">.*?</h1>',
        f'<h1 id="workspaceTitle">{latest_year} 年中国银行业100强 · {len(latest["records"])} 家</h1>',
        text,
        count=1,
    )
    text = re.sub(
        r'<p id="resultSummary">.*?</p>',
        f'<p id="resultSummary">数据口径：{latest["dataYear"]} 年末</p>',
        text,
        count=1,
    )
    text = re.sub(
        r'<div class="data-status" id="dataStatus" aria-live="polite">.*?</div>',
        f'<div class="data-status" id="dataStatus" aria-live="polite">最新数据 {latest_year} 年</div>',
        text,
        count=1,
    )
    source_pattern = re.compile(
        r'(<a class="source-link" id="officialSource" href=")[^"]*("[^>]*>).*?(</a>)'
    )
    text, count = source_pattern.subn(
        lambda match: (
            f'{match.group(1)}{html.escape(latest["officialUrl"], quote=True)}'
            f'{match.group(2)}{latest_year} 年中国银行业协会官方发布页{match.group(3)}'
        ),
        text,
        count=1,
    )
    if count != 1:
        raise RuntimeError("official source link not found exactly once")
    return text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    data = load_data()
    current = HTML_PATH.read_text(encoding="utf-8")
    expected = render(data, current)

    if args.check:
        if current != expected:
            print("index.html static fallback is stale")
            return 1
        print("index.html static fallback is up to date")
        return 0

    HTML_PATH.write_text(expected, encoding="utf-8")
    print(f"rendered latest year {max(b['rankingYear'] for b in data['years'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
