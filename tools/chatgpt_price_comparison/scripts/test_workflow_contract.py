from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github" / "workflows" / "update-chatgpt-prices.yml"


class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def test_cloudflare_is_primary_and_github_is_single_backup(self):
        self.assertIn("Cloudflare 09:05", self.text)
        self.assertIn("cron: '10 1 * * *'", self.text)
        self.assertNotIn("cron: '5 1 * * *'", self.text)
        self.assertIn("- cloudflare", self.text)
        self.assertNotIn("\n  push:\n", self.text)

    def test_daily_guard_requires_successful_production_proof(self):
        self.assertIn("daily_run_guard.py", self.text)
        self.assertIn("production_success_today", self.text)
        self.assertIn("actions/workflows/update-chatgpt-prices.yml/runs?status=success", self.text)
        self.assertIn("needs: prepare", self.text)
        self.assertIn("needs: [prepare, generate]", self.text)
        self.assertIn("needs: [prepare, generate, publish]", self.text)
        self.assertIn("needs.prepare.outputs.should_run == 'true'", self.text)

    def test_publish_waits_for_pages_and_verifies_canonical_production(self):
        self.assertIn("pages/builds/latest", self.text)
        self.assertIn("verify-production:", self.text)
        self.assertIn("verify-production.mjs --expected", self.text)
        self.assertIn("VERIFY: ${{ needs.verify-production.result }}", self.text)

    def test_only_main_can_publish(self):
        self.assertIn("github.ref == 'refs/heads/main'", self.text)
        self.assertNotIn("feat/chatgpt-price-comparison", self.text)


if __name__ == "__main__":
    unittest.main()
