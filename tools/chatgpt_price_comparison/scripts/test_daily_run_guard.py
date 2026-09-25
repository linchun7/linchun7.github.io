from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import daily_run_guard as guard
import pipeline as p
from test_pipeline import NOW, data_fixture, revise


class DailyRunGuardTests(unittest.TestCase):
    def test_production_proof_must_finish_after_current_data_generation(self):
        data = data_fixture()
        base = {
            "conclusion": "success",
            "head_branch": "main",
            "event": "workflow_dispatch",
            "created_at": p.stamp(NOW - 120),
        }
        older = dict(base, updated_at=p.stamp(NOW - 1))
        current = dict(base, updated_at=p.stamp(NOW + 60))
        self.assertFalse(guard.successful_production_proof([older], data, NOW + 120))
        self.assertTrue(guard.successful_production_proof([older, current], data, NOW + 120))

    def test_production_proof_rejects_wrong_branch_event_or_day(self):
        data = data_fixture()
        valid = {
            "conclusion": "success",
            "head_branch": "main",
            "event": "schedule",
            "created_at": p.stamp(NOW - 120),
            "updated_at": p.stamp(NOW + 60),
        }
        wrong_branch = dict(valid, head_branch="other")
        wrong_event = dict(valid, event="push")
        previous_day = dict(valid, created_at=p.stamp(NOW - 86400))
        self.assertFalse(guard.successful_production_proof([wrong_branch, wrong_event, previous_day], data, NOW + 120))
        self.assertTrue(guard.successful_production_proof([valid], data, NOW + 120))

    def test_cloudflare_skips_only_with_clean_data_and_successful_production_run(self):
        result = guard.decide("workflow_dispatch", "cloudflare", data_fixture(), NOW, True)
        self.assertFalse(result["should_run"])
        self.assertTrue(result["clean_today"])
        self.assertTrue(result["production_success_today"])

    def test_github_backup_skips_after_successful_primary(self):
        result = guard.decide("schedule", None, data_fixture(), NOW, True)
        self.assertFalse(result["should_run"])

    def test_clean_data_without_production_success_retries(self):
        result = guard.decide("schedule", None, data_fixture(), NOW, False)
        self.assertTrue(result["should_run"])

    def test_manual_run_is_never_suppressed(self):
        result = guard.decide("workflow_dispatch", "manual", data_fixture(), NOW, True)
        self.assertTrue(result["should_run"])

    def test_previous_beijing_day_runs(self):
        data = data_fixture()
        previous = NOW - 86400
        data["generated_at"] = p.stamp(previous)
        data["fx"]["updated_at"] = p.stamp(previous)
        for market in data["markets"]:
            market["last_checked_at"] = p.stamp(previous)
            if market.get("offers"):
                market["last_verified_at"] = p.stamp(previous)
        revise(data)
        result = guard.decide("schedule", None, data, NOW, True)
        self.assertTrue(result["should_run"])

    def test_unavailable_market_is_not_degraded(self):
        data = data_fixture()
        market = data["markets"][0]
        market["offers"] = []
        market["status"] = "unavailable"
        for key in ("currency", "unclassified_labels", "source_sha256", "fingerprint", "last_verified_at"):
            market.pop(key, None)
        revise(data)
        self.assertFalse(guard.decide("schedule", None, data, NOW, True)["should_run"])

    def test_retained_or_pending_market_keeps_backup_active(self):
        for status in ("retained", "pending"):
            with self.subTest(status=status):
                data = copy.deepcopy(data_fixture())
                data["markets"][0]["status"] = status
                revise(data)
                self.assertTrue(guard.decide("schedule", None, data, NOW, True)["should_run"])

    def test_fallback_or_stale_fx_keeps_backup_active(self):
        fallback = data_fixture()
        fallback["fx"]["fallback"] = True
        revise(fallback)
        self.assertTrue(guard.decide("schedule", None, fallback, NOW, True)["should_run"])
        stale = data_fixture()
        stale["fx"]["updated_at"] = p.stamp(NOW - p.FRESH - 1)
        revise(stale)
        self.assertTrue(guard.decide("schedule", None, stale, NOW, True)["should_run"])

    def test_unknown_dispatch_source_fails_closed(self):
        with self.assertRaises(ValueError):
            guard.decide("workflow_dispatch", "other", data_fixture(), NOW, True)


if __name__ == "__main__":
    unittest.main()
