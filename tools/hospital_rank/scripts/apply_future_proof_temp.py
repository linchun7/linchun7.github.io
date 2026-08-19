#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "script.js"
STYLE = ROOT / "style.css"
INDEX = ROOT / "index.html"
RENDER = ROOT / "scripts" / "render_static.py"
VALIDATE = ROOT / "scripts" / "validate_data.py"
README = ROOT / "data" / "README.md"
SMOKE = ROOT.parent / "browser-tests" / "hospital-rank-smoke.mjs"
FUTURE_TEST = ROOT / "scripts" / "test_future_year.py"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing expected text for {label}")
    return text.replace(old, new, 1)


def sub_once(text: str, pattern: str, repl: str, label: str, flags: int = 0) -> str:
    result, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"expected one match for {label}, got {count}")
    return result


# 1) Front-end: version rankings.json, rename history semantics, keep static fallback inert.
script = SCRIPT.read_text(encoding="utf-8")
script = replace_once(
    script,
    "const DISCLAIMER_COPY = '数字年份按官方名次展示；等级年份仅展示官方等级，同等级无官方先后。本站按各医院最近一次可用的数字排名作同等级内历史参考排序，不代表官方档内名次。';\n",
    "const DISCLAIMER_COPY = '数字年份按官方名次展示；等级年份仅展示官方等级，同等级无官方先后。本站按各医院最近一次可用的数字排名作同等级内历史参考排序，不代表官方档内名次。';\nconst RANKINGS_VERSION = document.documentElement.dataset.rankingsVersion || '';\n",
    "rankings version constant",
)
script = replace_once(
    script,
    "    const response = await fetch('./data/rankings.json');",
    "    const dataUrl = RANKINGS_VERSION ? `./data/rankings.json?v=${encodeURIComponent(RANKINGS_VERSION)}` : './data/rankings.json';\n    const response = await fetch(dataUrl);",
    "versioned data fetch",
)
script = script.replace("查看历年排名与历史名称：", "查看历年榜单与历史名称：")
script = script.replace("查看历年排名'", "查看历年榜单'")
script = script.replace("`${hospital.name} · 历年排名`", "`${hospital.name} · 历年榜单`")
script = replace_once(
    script,
    "        hospitalList.querySelectorAll('button').forEach(button => {\n            button.disabled = true;\n            button.title = '交互数据加载失败，当前仅显示静态榜单';\n        });\n",
    "",
    "obsolete static fallback buttons",
)
SCRIPT.write_text(script, encoding="utf-8")

# 2) CSS: move active inline page rules into style.css, then remove known dead legacy blocks.
index = INDEX.read_text(encoding="utf-8")
inline_match = re.search(r"\n    <style>\n(?P<css>.*?)\n    </style>\n", index, re.S)
if not inline_match:
    raise SystemExit("missing hospital_rank inline style block")
inline_css = inline_match.group("css")
index = index[:inline_match.start()] + "\n" + index[inline_match.end():]
style = STYLE.read_text(encoding="utf-8")

# Keep active workspace rule while dropping the removed overview UI.
style = style.replace(".overview-reference, .workspace {", ".workspace {")
style = re.sub(r"\n\.overview \{.*?\n\.overview-stats dd \{.*?\}\n", "\n", style, count=1, flags=re.S)
style = re.sub(r"\n\.location-button \{.*?\n\.location-button:hover, \.location-button:focus-visible \{.*?\}\n", "\n", style, count=1, flags=re.S)
style = re.sub(r"\n\.rank-history-row td \{.*?\n\.history-change\.is-system \{.*?\}\n", "\n", style, count=1, flags=re.S)
style = re.sub(r"\n\.stats-tooltip \{.*?\}\n", "\n", style, count=1, flags=re.S)
style = re.sub(r"\n\.history-source-name \{.*?\}\n", "\n", style, count=1, flags=re.S)
style = re.sub(r"\n\s*\.rank-history-list \{ grid-template-columns: 1fr; \}\n\s*\.rank-history-panel \{.*?\}\n\s*\.rank-history-header \{.*?\}\n", "\n", style, count=1, flags=re.S)

# Inline rules are the current active page-specific layer; append once to the external stylesheet.
style = style.rstrip() + "\n\n/* Hospital ranking page-specific layout. Kept external so cache/version checks cover every visual change. */\n" + inline_css.strip() + "\n"
STYLE.write_text(style, encoding="utf-8")
INDEX.write_text(index, encoding="utf-8")

# 3) Static renderer: rankings hash, semantic header, plain-text static hospital cells.
render = RENDER.read_text(encoding="utf-8")
render = replace_once(
    render,
    'SCRIPT_PATH = ROOT / "script.js"\n',
    'SCRIPT_PATH = ROOT / "script.js"\nRANKINGS_PATH = ROOT / "data" / "rankings.json"\n',
    "rankings path",
)
render = replace_once(
    render,
    '        title = "查看历年排名"\n        if aliases:\n            title = "查看历年排名与历史名称：" + "、".join(aliases)\n',
    '',
    "static button title setup",
)
render = sub_once(
    render,
    r'            "                            <td>",\n            f\'                                <button type="button" class="hospital-history-button".*?\n            "                            </td>",',
    '            "                            <td>",\n            f\'                                <span class="hospital-name static-hospital-name">{esc(hospital.get("name") or record.get("sourceName"))}</span>\',\n            "                            </td>",',
    "static hospital button",
    re.S,
)
render = replace_once(
    render,
    'def asset_version() -> str:\n    return f"{git_blob_short_hash(STYLE_PATH)}-{git_blob_short_hash(SCRIPT_PATH)}"\n',
    'def asset_version() -> str:\n    return f"{git_blob_short_hash(STYLE_PATH)}-{git_blob_short_hash(SCRIPT_PATH)}"\n\n\ndef rankings_version() -> str:\n    return git_blob_short_hash(RANKINGS_PATH)\n',
    "rankings hash helper",
)
render = replace_once(
    render,
    '    result = replace_tag_text(result, "dataStatus", f"最新数据 {year} 年")\n    result = replace_disclaimer(result)\n',
    '    result = replace_tag_text(result, "dataStatus", f"最新数据 {year} 年")\n    result = replace_disclaimer(result)\n\n    rank_label = "等级" if block.get("rankingMode") == "grade" else "排名"\n    result = replace_tag_text(result, "rankColumnLabel", rank_label)\n    result = re.sub(\n        r\'<html lang="zh-CN"(?: data-rankings-version="[^"]*")?>\',\n        f\'<html lang="zh-CN" data-rankings-version="{rankings_version()}">\',\n        result,\n        count=1,\n    )\n',
    "static semantic header and data version",
)
render = replace_once(
    render,
    '            "assetVersion": asset_version(),\n',
    '            "assetVersion": asset_version(),\n            "rankingsVersion": rankings_version(),\n',
    "check output data version",
)
render = replace_once(
    render,
    '        "assetVersion": asset_version(),\n',
    '        "assetVersion": asset_version(),\n        "rankingsVersion": rankings_version(),\n',
    "render output data version",
)
RENDER.write_text(render, encoding="utf-8")

# Seed rankColumnLabel in template so no-JS output has the right semantic label after rendering.
index = INDEX.read_text(encoding="utf-8")
index = sub_once(
    index,
    r'(<button type="button" data-sort="排名">)(?:<span id="rankColumnLabel">.*?</span>|[^<]*)(\s*<span class="sort-indicator")',
    r'\1<span id="rankColumnLabel">等级</span>\2',
    "static rank label",
)
index = index.replace("查看医院历年排名。", "查看医院历年榜单。")
index = index.replace("查看医院历年排名", "查看医院历年榜单")
index = index.replace("医院历年排名</h2>", "医院历年榜单</h2>")
INDEX.write_text(index, encoding="utf-8")

# 4) Validator: immutable 2009-2023 baseline + generic validation for future official years.
validator = r'''#!/usr/bin/env python3
"""Validate committed hospital ranking JSON without network access."""
from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

GRADE_ORDER = ["A++++", "A+++", "A++", "A+", "A"]
BASELINE_COUNTS = {2009: 50, 2010: 80, **{year: 100 for year in range(2011, 2024)}}
BASELINE_RECORDS = sum(BASELINE_COUNTS.values())
BASELINE_HOSPITAL_ENTITIES = 128


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def norm(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    return re.sub(r"[\s()（）\[\]【】{}·•,，。;；:：'\"“”‘’/\\\-—_]+", "", value).lower()


def fail(message: str) -> None:
    raise AssertionError(message)


def same_number(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is b
    try:
        return math.isclose(float(a), float(b), rel_tol=0.0, abs_tol=1e-9)
    except (TypeError, ValueError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[1] / "data"
    parser.add_argument("--data-dir", type=Path, default=root)
    args = parser.parse_args()

    rankings = load(args.data_dir / "rankings.json")
    snapshot = load(args.data_dir / "source-snapshot.json")
    audit = load(args.data_dir / "audit.json")

    if rankings.get("schemaVersion") != 1 or snapshot.get("schemaVersion") != 1 or audit.get("schemaVersion") != 1:
        fail("schemaVersion must be 1 for all hospital data files")
    if snapshot.get("source", {}).get("rawHtmlStored") is not False:
        fail("source snapshot must explicitly declare rawHtmlStored=false")
    if audit.get("status") != "ok":
        fail(f"migration audit is not ok: {audit.get('status')}")
    if audit.get("summary", {}).get("unmatchedSource") != 0 or audit.get("summary", {}).get("unmatchedLegacy") != 0:
        fail("migration audit still has unmatched records")
    if audit.get("summary", {}).get("valueDifferences") != 0:
        fail("migration audit has unresolved source/legacy value differences")
    if audit.get("summary", {}).get("entityRecoveryFuzzy") != 0:
        fail("migration baseline must not depend on fuzzy entity recovery")

    hospitals = rankings.get("hospitals")
    years = rankings.get("years")
    if not isinstance(hospitals, list) or not isinstance(years, list):
        fail("rankings.hospitals and rankings.years must be arrays")

    hospital_by_id: dict[str, dict[str, Any]] = {}
    token_owner: dict[str, str] = {}
    for hospital in hospitals:
        hospital_id = hospital.get("id")
        if not isinstance(hospital_id, str) or not re.fullmatch(r"h_[0-9a-f]{10}", hospital_id):
            fail(f"invalid hospital id: {hospital_id!r}")
        if hospital_id in hospital_by_id:
            fail(f"duplicate hospital id: {hospital_id}")
        if not hospital.get("name"):
            fail(f"hospital {hospital_id} has no canonical name")
        if not hospital.get("province") or not hospital.get("city"):
            fail(f"hospital {hospital['name']} has incomplete location metadata")
        hospital_by_id[hospital_id] = hospital

        names = [hospital["name"], *(hospital.get("aliases") or [])]
        if len(names) != len(set(names)):
            fail(f"hospital {hospital['name']} has duplicate aliases")
        for name in names:
            token = norm(name)
            if not token:
                fail(f"hospital {hospital['name']} has an empty normalized name")
            previous = token_owner.get(token)
            if previous and previous != hospital_id:
                fail(f"name/alias collision between {previous} and {hospital_id}: {name}")
            token_owner[token] = hospital_id

    source_by_year = {int(block["year"]): block for block in snapshot.get("years", [])}
    normalized_by_year = {int(block["year"]): block for block in years}
    if len(source_by_year) != len(snapshot.get("years", [])) or len(normalized_by_year) != len(years):
        fail("duplicate year blocks are not allowed")
    if not set(BASELINE_COUNTS).issubset(source_by_year) or not set(BASELINE_COUNTS).issubset(normalized_by_year):
        fail("verified 2009–2023 historical baseline must remain complete")
    if set(source_by_year) != set(normalized_by_year):
        fail("source snapshot and normalized rankings must contain the same years")

    used_hospital_ids: set[str] = set()
    total_records = 0
    baseline_records = 0
    for year in sorted(normalized_by_year):
        source_block = source_by_year[year]
        block = normalized_by_year[year]
        if source_block.get("rankingMode") != block.get("rankingMode"):
            fail(f"{year}: source and normalized rankingMode differ")

        source_rows = source_block.get("records", [])
        normalized_rows = block.get("records", [])
        if year in BASELINE_COUNTS:
            expected_count = BASELINE_COUNTS[year]
            if len(source_rows) != expected_count or len(normalized_rows) != expected_count:
                fail(f"{year}: verified baseline record count changed")
        elif year <= 2023:
            fail(f"unexpected pre-baseline year: {year}")
        elif not source_rows or len(source_rows) != len(normalized_rows):
            fail(f"{year}: future year must have a non-empty source-aligned record set")

        mode = block.get("rankingMode")
        if mode not in {"numeric", "grade"}:
            fail(f"{year}: unsupported rankingMode {mode!r}")
        source_records = {record["sourceName"]: record for record in source_rows}
        if len(source_records) != len(source_rows):
            fail(f"{year}: duplicate source names in source snapshot")
        seen_ids: set[str] = set()
        seen_source_names: set[str] = set()
        previous_rank = 0
        grades = Counter()

        for record in normalized_rows:
            total_records += 1
            if year in BASELINE_COUNTS:
                baseline_records += 1
            hospital_id = record.get("hospitalId")
            source_name = record.get("sourceName")
            if hospital_id not in hospital_by_id:
                fail(f"{year}: unknown hospitalId {hospital_id}")
            if hospital_id in seen_ids:
                fail(f"{year}: duplicate hospital entity {hospital_id}")
            if not source_name or source_name in seen_source_names:
                fail(f"{year}: empty or duplicate sourceName {source_name!r}")
            seen_ids.add(hospital_id)
            seen_source_names.add(source_name)
            used_hospital_ids.add(hospital_id)

            hospital = hospital_by_id[hospital_id]
            if source_name != hospital["name"] and source_name not in hospital.get("aliases", []):
                fail(f"{year}: sourceName is not preserved in entity aliases: {source_name}")
            source = source_records.get(source_name)
            if source is None:
                fail(f"{year}: normalized sourceName absent from source snapshot: {source_name}")

            if mode == "numeric":
                if record.get("grade") is not None:
                    fail(f"{year}: numeric row has grade: {source_name}")
                rank = record.get("rank")
                if not isinstance(rank, int) or rank < previous_rank:
                    fail(f"{year}: invalid/non-monotonic numeric rank for {source_name}: {rank}")
                previous_rank = rank
                for field in ("rank", "specialtyReputation", "researchAcademic", "overallScore"):
                    if not same_number(record.get(field), source.get(field)):
                        fail(f"{year}: {field} differs from source snapshot for {source_name}")
            else:
                if record.get("rank") is not None:
                    fail(f"{year}: grade row has numeric rank: {source_name}")
                grade = record.get("grade")
                if grade not in GRADE_ORDER:
                    fail(f"{year}: invalid grade {grade!r} for {source_name}")
                grades[grade] += 1
                for field in ("specialtyReputation", "researchAcademic", "overallScore"):
                    if record.get(field) is not None:
                        fail(f"{year}: grade row must not invent {field}: {source_name}")
                if source.get("grade") != grade:
                    fail(f"{year}: grade differs from source snapshot for {source_name}")

        if mode == "grade" and any(grade not in GRADE_ORDER for grade in grades):
            fail(f"{year}: unsupported grade values")
        if year == 2023 and any(grades[grade] != 20 for grade in GRADE_ORDER):
            fail(f"2023: expected verified 20 hospitals per grade, got {dict(grades)}")

    if baseline_records != BASELINE_RECORDS:
        fail(f"verified historical baseline must remain {BASELINE_RECORDS} records, got {baseline_records}")
    if total_records < BASELINE_RECORDS:
        fail(f"record count cannot fall below verified baseline {BASELINE_RECORDS}")
    unused = set(hospital_by_id) - used_hospital_ids
    if unused:
        fail(f"unused hospital entities: {sorted(unused)}")
    if len(hospital_by_id) < BASELINE_HOSPITAL_ENTITIES:
        fail(f"hospital entities cannot fall below verified baseline {BASELINE_HOSPITAL_ENTITIES}")

    print(json.dumps({
        "status": "ok",
        "years": len(normalized_by_year),
        "latestYear": max(normalized_by_year),
        "records": total_records,
        "baselineRecords": baseline_records,
        "hospitalEntities": len(hospital_by_id),
        "sourceValidationWarnings": len(audit.get("sourceValidationWarnings", [])),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''
VALIDATE.write_text(validator, encoding="utf-8")

# 5) Future-year regression: duplicate the verified 2023 grade block as synthetic 2024 in a temp data dir.
future_test = r'''#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate_data.py"
DATA = ROOT / "data"

with tempfile.TemporaryDirectory() as temp_dir:
    target = Path(temp_dir)
    payloads = {}
    for name in ("rankings.json", "source-snapshot.json", "audit.json"):
        payloads[name] = json.loads((DATA / name).read_text(encoding="utf-8"))

    rankings_2023 = next(block for block in payloads["rankings.json"]["years"] if int(block["year"]) == 2023)
    snapshot_2023 = next(block for block in payloads["source-snapshot.json"]["years"] if int(block["year"]) == 2023)
    future_rankings = copy.deepcopy(rankings_2023)
    future_snapshot = copy.deepcopy(snapshot_2023)
    future_rankings["year"] = 2024
    future_snapshot["year"] = 2024
    payloads["rankings.json"]["years"].append(future_rankings)
    payloads["source-snapshot.json"]["years"].append(future_snapshot)

    for name, payload in payloads.items():
        (target / name).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    subprocess.run(["python3", str(VALIDATOR), "--data-dir", str(target)], check=True)

print("future-year validator regression: ok")
'''
FUTURE_TEST.write_text(future_test, encoding="utf-8")

# 6) README: explicitly document immutable baseline + supported future years and cache/render update path.
readme = README.read_text(encoding="utf-8")
readme = replace_once(
    readme,
    "- `rankings.json`：前端唯一正式数据源。包含医院实体注册表与 2009–2023 各年度榜单。",
    "- `rankings.json`：前端唯一正式数据源。包含医院实体注册表与 2009–2023 已核验历史基线，以及后续经同等来源核验后新增的正式年度榜单。",
    "README rankings description",
)
readme = replace_once(
    readme,
    "validator 会检查：\n\n- 2009–2023 年份完整性与每年记录数；",
    "validator 会检查：\n\n- 2009–2023 已核验历史基线完整性与固定记录数；\n- 允许 2024 及之后新增正式年度，但要求 `rankings.json` 与 `source-snapshot.json` 年份集合、记录数和来源值一致；",
    "README validator behavior",
)
readme += "\n\n## 新增年度发布流程\n\n新增正式年度时，同时更新 `rankings.json` 与 `source-snapshot.json`，完成实体/历史名称核验后运行：\n\n```bash\npython tools/hospital_rank/scripts/validate_data.py\npython tools/hospital_rank/scripts/test_future_year.py\npython tools/hospital_rank/scripts/render_static.py\npython tools/hospital_rank/scripts/render_static.py --check\n```\n\n`render_static.py` 会自动选择数据中的最大年份作为静态 HTML 默认榜单，并同步 CSS/JS 内容版本与 `rankings.json` 内容版本；因此新增 2024 后页面静态快照、默认年份和数据请求会一起切换到 2024。\n"
README.write_text(readme, encoding="utf-8")

# 7) Browser regression coverage for no-JS semantics, external CSS and versioned JSON request.
smoke = SMOKE.read_text(encoding="utf-8")
smoke = replace_once(
    smoke,
    "    assert.match(await staticPage.locator('noscript').innerText(), /最新年度静态榜单/);\n",
    "    assert.match(await staticPage.locator('noscript').innerText(), /最新年度静态榜单/);\n    assert.equal((await staticPage.locator('#rankColumnLabel').innerText()).trim(), latestYearBlock.rankingMode === 'grade' ? '等级' : '排名', 'no-JS static header should match the latest ranking mode');\n    assert.equal(await staticPage.locator('#hospitalList .hospital-history-button').count(), 0, 'no-JS static hospital names must not be dead buttons');\n    assert.equal(await staticPage.locator('head > style').count(), 0, 'hospital page-specific CSS should stay in the versioned external stylesheet');\n    assert.match((await staticPage.locator('html').getAttribute('data-rankings-version')) || '', /^[0-9a-f]{8}$/, 'static HTML should carry a rankings content version');\n",
    "no-js regressions",
)
smoke = replace_once(
    smoke,
    "const pageErrors = [];\npage.on('pageerror', error => pageErrors.push(error));\n",
    "const pageErrors = [];\nconst rankingRequests = [];\npage.on('pageerror', error => pageErrors.push(error));\npage.on('request', request => { if (request.url().includes('/tools/hospital_rank/data/rankings.json')) rankingRequests.push(request.url()); });\n",
    "ranking request capture",
)
smoke = replace_once(
    smoke,
    "    assert.equal((await page.locator('#dataStatus').innerText()).trim(), `最新数据 ${latestYear} 年`, 'latest-data status should stay concise');\n",
    "    assert.equal((await page.locator('#dataStatus').innerText()).trim(), `最新数据 ${latestYear} 年`, 'latest-data status should stay concise');\n    assert.equal(rankingRequests.length, 1, 'rankings JSON should be requested once during initialization');\n    assert.match(rankingRequests[0], /rankings\\.json\\?v=[0-9a-f]{8}(?:&|$)/, 'rankings JSON request should be cache-busted by its content version');\n",
    "versioned rankings request assertion",
)
smoke = smoke.replace("/历年排名/", "/历年榜单/")
SMOKE.write_text(smoke, encoding="utf-8")

print("future-proof cleanup applied")
