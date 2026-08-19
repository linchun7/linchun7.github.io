#!/usr/bin/env python3
"""Render latest-year metadata, resource versions and full no-JS ranking preview."""
from __future__ import annotations
import argparse, base64, gzip, hashlib, html, importlib.util, re
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


def content_versions() -> tuple[str, str, str]:
    rankings_version = hashlib.sha256((ROOT / "data" / "rankings.json").read_bytes()).hexdigest()[:10]
    style_version = resource_version(ROOT / "style.css")
    script_version = resource_version(ROOT / "script.js")
    return rankings_version, style_version, script_version


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


def history_title(bank: dict, shown_name: str) -> str:
    aliases = bank.get("aliases") or []
    if bank.get("name") and bank["name"] != shown_name:
        return f"现名：{bank['name']}；查看历年排名与更名信息"
    if aliases:
        return f"查看历年排名与历史名称：{'、'.join(aliases)}"
    return "查看历年排名"


def render(data: dict, current_html: str) -> str:
    latest = max(data["years"], key=lambda block: block["rankingYear"])
    latest_year = latest["rankingYear"]
    bank_by_id = {bank["id"]: bank for bank in data["banks"]}
    rankings_version, style_version, script_version = content_versions()
    options = "\n".join(f'                            <option value="{year}"{" selected" if year == latest_year else ""}>{year}年</option>' for year in sorted((b["rankingYear"] for b in data["years"]), reverse=True))
    rows = []
    for record in latest["records"]:
        bank = bank_by_id[record["bankId"]]
        change, change_class = rank_change(
            record,
            previous_record(data, record["bankId"], latest_year),
            has_earlier_record(data, record["bankId"], latest_year),
        )
        bank_id = html.escape(record["bankId"])
        shown_name = html.escape(record["sourceName"])
        title = html.escape(history_title(bank, record["sourceName"]), quote=True)
        rows.append(
            f'                        <tr class="data-row" data-bank-id="{bank_id}" data-static-prerendered="true">'
            f'<td><span class="rank-value">{record["rank"]}</span></td>'
            f'<td><button class="bank-history-button" type="button" data-bank-id="{bank_id}" aria-haspopup="dialog" title="{title}" disabled>'
            f'<span class="bank-name">{shown_name}</span><span class="history-affordance" aria-hidden="true">›</span></button></td>'
            f'<td><span class="type-badge">{html.escape(bank["type"])}</span></td>'
            f'<td>{record["coreTier1Capital"]:,.2f}</td><td>{record["assets"]:,.2f}</td><td>{record["netProfit"]:,.2f}</td>'
            f'<td><span class="change {change_class}">{change}</span></td></tr>'
        )
    text = re.sub(r'data-latest-year="\d+"', f'data-latest-year="{latest_year}"', current_html, count=1)
    text = re.sub(r'data-rankings-version="[^"]*"', f'data-rankings-version="{rankings_version}"', text, count=1)
    text = replace_marker_block(text, YEAR_START, YEAR_END, options)
    text = replace_marker_block(text, ROWS_START, ROWS_END, "\n".join(rows))
    text = re.sub(r'<h1 id="workspaceTitle">.*?</h1>', f'<h1 id="workspaceTitle">{latest_year} 年中国银行业100强榜单</h1>', text, count=1)
    text = re.sub(r'<p id="resultSummary">.*?</p>', f'<p id="resultSummary">{len(latest["records"])} 家银行 · 榜单基于 {latest["dataYear"]} 年末财务数据</p>', text, count=1)
    text = re.sub(
        r'<noscript><p class="noscript-notice">.*?</p></noscript>',
        '<noscript><p class="noscript-notice">当前静态页已显示最新完整100强；启用 JavaScript 后可切换年份、筛选、排序和查看历年排名。</p></noscript>',
        text,
        count=1,
    )
    text = re.sub(r'<div class="data-status" id="dataStatus" aria-live="polite">.*?</div>', f'<div class="data-status" id="dataStatus" aria-live="polite">最新榜单 {latest_year} 年</div>', text, count=1)
    text, count = re.subn(r'<link rel="stylesheet" href="style\.css(?:\?v=[^"]*)?">', f'<link rel="stylesheet" href="style.css?v={style_version}">', text, count=1)
    if count != 1: raise RuntimeError("stylesheet link not found exactly once")
    text, count = re.subn(r'<script src="script\.js(?:\?v=[^"]*)?" defer></script>', f'<script src="script.js?v={script_version}" defer></script>', text, count=1)
    if count != 1: raise RuntimeError("script tag not found exactly once")
    if re.search(r'class="scope-note"|id="officialSource"|id="yearNote"|id="brandSubtitle"', text):
        raise RuntimeError("deprecated scope/source/brand-subtitle UI remains in index.html")
    return text


def dump_base64_chunks(label: str, raw: bytes, chunk_size: int = 3000) -> None:
    encoded = base64.b64encode(raw).decode("ascii")
    chunks = [encoded[i:i + chunk_size] for i in range(0, len(encoded), chunk_size)]
    print(f"{label}_CHUNKS={len(chunks)}")
    for index, chunk in enumerate(chunks):
        print(f"{label}_{index:03d}={chunk}")


def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--check", action="store_true"); args = parser.parse_args()
    data = MODULE.load_rankings(); current = HTML_PATH.read_text(encoding="utf-8"); expected = render(data, current)
    if args.check:
        if current != expected:
            rankings_version, style_version, script_version = content_versions()
            current_raw = current.encode("utf-8")
            expected_raw = expected.encode("utf-8")
            print(f"index.html static preview is stale: rankings={rankings_version} style={style_version} script={script_version}")
            print(f"STATIC_HTML_SIZE current={len(current_raw)} expected={len(expected_raw)} delta={len(expected_raw)-len(current_raw)} gzip_current={len(gzip.compress(current_raw, compresslevel=9))} gzip_expected={len(gzip.compress(expected_raw, compresslevel=9))}")
            dump_base64_chunks("INDEX_B64", expected_raw)
            smoke_path = ROOT.parent / "browser-tests" / "bank-rank-smoke.mjs"
            smoke = smoke_path.read_text(encoding="utf-8")
            smoke_expected = smoke.replace(
                "count(), 20, 'failed dynamic load should preserve all 20 static preview rows'",
                "count(), 100, 'failed dynamic load should preserve all 100 static ranking rows'",
            ).replace(
                "/20 家静态预览 · 动态数据加载失败/",
                "/100 家静态预览 · 动态数据加载失败/",
            )
            if smoke_expected == smoke:
                raise RuntimeError("bank-rank smoke replacements did not apply")
            dump_base64_chunks("SMOKE_B64", smoke_expected.encode("utf-8"))
            return 1
        print("index.html static preview is up to date")
        return 0
    HTML_PATH.write_text(expected, encoding="utf-8"); print(f"rendered latest year {max(b['rankingYear'] for b in data['years'])}"); return 0


if __name__ == "__main__": raise SystemExit(main())
