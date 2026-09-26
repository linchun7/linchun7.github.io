from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github" / "workflows" / "update-chatgpt-prices.yml"


class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def test_cloudflare_is_primary_and_github_has_one_0910_fallback(self):
        self.assertIn("Cloudflare 09:05", self.text)
        self.assertIn("北京时间 09:10", self.text)
        self.assertIn("cron: '10 9 * * *'", self.text)
        self.assertIn("timezone: 'Asia/Shanghai'", self.text)
        self.assertEqual(self.text.count("- cron:"), 1)
        self.assertNotIn("cron: '35 1 * * *'", self.text)
        self.assertNotIn("cron: '10 2 * * *'", self.text)
        self.assertNotIn("cron: '5 1 * * *'", self.text)
        self.assertIn("- cloudflare", self.text)
        self.assertNotIn("\n  push:\n", self.text)

    def test_prepare_and_generate_resolve_latest_main(self):
        # Scheduled/dispatch runs can wait behind the primary. Resolve main when
        # the jobs actually start so the backup sees a just-published primary.
        self.assertGreaterEqual(self.text.count("ref: main"), 2)

    def test_daily_guard_requires_successful_production_proof(self):
        self.assertIn("daily_run_guard.py", self.text)
        self.assertIn("production_success_today", self.text)
        self.assertIn("successful_production_proof", self.text)
        self.assertIn("actions/workflows/update-chatgpt-prices.yml/runs?status=success", self.text)
        self.assertIn("needs: prepare", self.text)
        self.assertIn("needs: [prepare, generate]", self.text)
        self.assertIn("needs: [prepare, generate, publish]", self.text)
        self.assertIn("needs.prepare.outputs.should_run == 'true'", self.text)

    def test_publish_waits_for_pages_and_verifies_canonical_production(self):
        self.assertIn("pages/builds/latest", self.text)
        self.assertNotIn("Request Pages build for published data", self.text)
        self.assertIn("seq 1 90", self.text)
        self.assertIn("within 7.5 minutes", self.text)
        self.assertIn("verify-production:", self.text)
        self.assertIn("verify-production.mjs --expected", self.text)
        self.assertIn("--expected-index", self.text)
        verifier = (ROOT / "tools" / "chatgpt_price_comparison" / "scripts" / "verify-production.mjs").read_text(encoding="utf-8")
        self.assertIn("assetVersionsOf", verifier)
        self.assertIn("production asset content does not match version", verifier)
        self.assertIn("VERIFY: ${{ needs.verify-production.result }}", self.text)

    def test_publish_uses_least_privilege(self):
        self.assertIn("contents: write", self.text)
        self.assertIn("pages: read", self.text)
        self.assertNotIn("pages: write", self.text)

    def test_future_plan_browser_requirement_is_fixture_only(self):
        validate = (ROOT / ".github" / "workflows" / "validate-chatgpt-prices.yml").read_text(encoding="utf-8")
        self.assertIn("REQUIRE_FUTURE_PLAN=1 node tools/chatgpt_price_comparison/scripts/browser-test.mjs", validate)
        self.assertNotIn("REQUIRE_FUTURE_PLAN=1", self.text)

    def test_validation_dependencies_are_project_local(self):
        validate = (ROOT / ".github" / "workflows" / "validate-chatgpt-prices.yml").read_text(encoding="utf-8")
        self.assertIn("tools/chatgpt_price_comparison/**", validate)
        self.assertNotIn("tools/icloud_price_comparison", validate)
        self.assertIn("branches: [main]", validate)
        self.assertNotIn("feat/chatgpt-price-comparison", validate)
        for relative in ("app.js", "index.template.html", "scripts/pipeline.py"):
            project_file = (ROOT / "tools" / "chatgpt_price_comparison" / relative).read_text(encoding="utf-8")
            self.assertNotIn("icloud_price_comparison", project_file)

    def test_only_main_can_publish(self):
        self.assertIn("github.ref == 'refs/heads/main'", self.text)
        self.assertNotIn("feat/chatgpt-price-comparison", self.text)


if __name__ == "__main__":
    unittest.main()
