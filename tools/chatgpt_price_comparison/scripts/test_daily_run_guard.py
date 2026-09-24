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
    def test_cloudflare_skips_clean_publication_from_same_beijing_day(self):
        result = guard.decide("workflow_dispatch", "cloudflare", data_fixture(), NOW)
        self.assertFalse(result["should_run"])
        self.assertTrue(result["clean_today"])
        self.assertEqual(result["trigger_source"], "cloudflare")

    def test_github_schedule_skips_after_clean_primary(self):
        result = guard.decide("schedule", None, data_fixture(), NOW)
        self.assertFalse(result["should_run"])
        self.assertEqual(result["trigger_source"], "github-schedule")

    def test_manual_run_is_never_suppressed(self):
        result = guard.decide("workflow_dispatch", "manual", data_fixture(), NOW)
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
        result = guard.decide("schedule", None, data, NOW)
        self.assertTrue(result["should_run"])
        self.assertFalse(result["clean_today"])

    def test_unavailable_market_is_not_treated_as_degraded(self):
        data = data_fixture()
        market = data["markets"][0]
        market["offers"] = []
        market["status"] = "unavailable"
        market.pop("currency", None)
        market.pop("unclassified_labels", None)
        market.pop("source_sha256", None)
        market.pop("fingerprint", None)
        market.pop("last_verified_at", None)
        revise(data)
        self.assertFalse(guard.decide("schedule", None, data, NOW)["should_run"])

    def test_retained_or_pending_market_keeps_backup_active(self):
        for status in ("retained", "pending"):
            with self.subTest(status=status):
                data = copy.deepcopy(data_fixture())
                data["markets"][0]["status"] = status
                revise(data)
                self.assertTrue(guard.decide("schedule", None, data, NOW)["should_run"])

    def test_fallback_or_stale_fx_keeps_backup_active(self):
        fallback = data_fixture()
        fallback["fx"]["fallback"] = True
        revise(fallback)
        self.assertTrue(guard.decide("schedule", None, fallback, NOW)["should_run"])

        stale = data_fixture()
        stale["fx"]["updated_at"] = p.stamp(NOW - p.FRESH - 1)
        revise(stale)
        self.assertTrue(guard.decide("schedule", None, stale, NOW)["should_run"])

    def test_unknown_dispatch_source_fails_closed(self):
        with self.assertRaises(ValueError):
            guard.decide("workflow_dispatch", "other", data_fixture(), NOW)


if __name__ == "__main__":
    unittest.main()
