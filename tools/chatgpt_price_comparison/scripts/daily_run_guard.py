#!/usr/bin/env python3
"""Daily idempotence guard for automatic ChatGPT price refreshes."""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pipeline

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "prices.json"
BEIJING = timezone(timedelta(hours=8))
ALLOWED_DISPATCH_SOURCES = {"manual", "cloudflare"}


def _source(event_name: str, requested: str | None) -> tuple[str, bool]:
    if event_name == "schedule":
        return "github-schedule", True
    if event_name == "workflow_dispatch":
        source = (requested or "manual").strip() or "manual"
        if source not in ALLOWED_DISPATCH_SOURCES:
            raise ValueError("unsupported workflow_dispatch trigger source")
        return source, source == "cloudflare"
    raise ValueError("automatic updater only accepts schedule or workflow_dispatch")


def _beijing_date(timestamp: float):
    return datetime.fromtimestamp(timestamp, timezone.utc).astimezone(BEIJING).date()


def successful_production_proof(runs: list[dict], data: dict, now: float) -> bool:
    """Require a successful automatic/manual updater proof that finished after this data was generated."""
    generated = pipeline.epoch(data["generated_at"])
    today = _beijing_date(now)
    for run in runs:
        if (
            run.get("conclusion") != "success"
            or run.get("head_branch") != "main"
            or run.get("event") not in ("schedule", "workflow_dispatch")
            or not run.get("created_at")
            or not run.get("updated_at")
        ):
            continue
        try:
            created = pipeline.epoch(run["created_at"])
            updated = pipeline.epoch(run["updated_at"])
        except ValueError:
            continue
        if _beijing_date(created) == today and updated >= generated:
            return True
    return False


def clean_publication_today(data: dict, now: float) -> bool:
    """True only when today's committed artifact is accepted, non-degraded and fresh."""
    pipeline.validate(data, now)
    if _beijing_date(pipeline.epoch(data["generated_at"])) != _beijing_date(now):
        return False
    markets = data.get("markets", [])
    if not markets or any(market.get("status") != "verified" for market in markets):
        return False
    fx = data.get("fx")
    if not isinstance(fx, dict) or fx.get("fallback") is not False:
        return False
    fx_time = pipeline.epoch(fx["updated_at"])
    return not (fx_time > now + 300 or now - fx_time > pipeline.FRESH)


def decide(event_name: str, requested: str | None, data: dict, now: float,
           production_success_today: bool = False) -> dict:
    source, automatic = _source(event_name, requested)
    clean_today = clean_publication_today(data, now)
    should_run = not automatic or not (clean_today and production_success_today)
    return {
        "should_run": should_run,
        "trigger_source": source,
        "clean_today": clean_today,
        "production_success_today": production_success_today,
        "date_beijing": str(_beijing_date(now)),
    }


def _append(path: str | None, lines: list[str]) -> None:
    if not path:
        return
    with open(path, "a", encoding="utf-8") as stream:
        stream.write("\n".join(lines) + "\n")


def main() -> None:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc).timestamp()
    result = decide(
        os.environ.get("GITHUB_EVENT_NAME", ""),
        os.environ.get("REQUESTED_TRIGGER_SOURCE"),
        data,
        now,
        os.environ.get("PRODUCTION_SUCCESS_TODAY", "").lower() == "true",
    )
    _append(os.environ.get("GITHUB_OUTPUT"), [
        f"should_run={str(result['should_run']).lower()}",
        f"trigger_source={result['trigger_source']}",
    ])
    if result["should_run"]:
        message = f"{result['trigger_source']} 将执行 {result['date_beijing']} 的价格核验。"
    else:
        message = f"{result['date_beijing']} 已有非降级数据和成功生产运行证明；备用触发安全跳过。"
    print(message)
    _append(os.environ.get("GITHUB_STEP_SUMMARY"), [
        "## ChatGPT 价格每日触发检查",
        "",
        f"- 触发来源：{result['trigger_source']}",
        f"- 北京日期：{result['date_beijing']}",
        f"- 当日数据非降级：{'是' if result['clean_today'] else '否'}",
        f"- 当日完整生产运行成功：{'是' if result['production_success_today'] else '否'}",
        f"- 本次执行抓取：{'是' if result['should_run'] else '否'}",
    ])


if __name__ == "__main__":
    main()
