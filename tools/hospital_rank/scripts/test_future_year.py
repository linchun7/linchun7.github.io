#!/usr/bin/env python3
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
