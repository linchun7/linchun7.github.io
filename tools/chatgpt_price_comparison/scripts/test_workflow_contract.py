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
        self.assertIn("Cloudflare 08:25", self.text)
        self.assertIn("cron: '30 0 * * *'", self.text)
        self.assertNotIn("cron: '25 0 * * *'", self.text)
        self.assertIn("- cloudflare", self.text)
        self.assertNotIn("\n  push:\n", self.text)

    def test_daily_guard_controls_expensive_jobs(self):
        self.assertIn("daily_run_guard.py", self.text)
        self.assertIn("needs: prepare", self.text)
        self.assertIn("needs: [prepare, generate]", self.text)
        self.assertIn("needs: [prepare, generate, publish]", self.text)
        self.assertIn("needs.prepare.outputs.should_run == 'true'", self.text)

    def test_only_main_can_publish(self):
        self.assertIn("github.ref == 'refs/heads/main'", self.text)
        self.assertNotIn("feat/chatgpt-price-comparison", self.text)


if __name__ == "__main__":
    unittest.main()
