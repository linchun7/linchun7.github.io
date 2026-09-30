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
        # Prepare starts from the triggering SHA so an old rerun can detect a
        # changed workflow, then explicitly resolves latest main. Generate also
        # resolves main when it actually starts.
        self.assertIn("Resolve latest main and reject stale workflow rerun", self.text)
        self.assertIn("STALE_WORKFLOW_DEFINITION", self.text)
        self.assertIn("git fetch origin main --depth=1", self.text)
        self.assertIn("validated_main_sha: ${{ steps.resolve_main.outputs.validated_main_sha }}", self.text)
        self.assertIn("validated_main_sha=$latest_sha", self.text)
        self.assertIn("ref: ${{ needs.prepare.outputs.validated_main_sha }}", self.text)
        self.assertIn("CHATGPT_GENERATION_BASE_DRIFT", self.text)
        generate = self.text[self.text.index("\n  generate:"):self.text.index("\n  publish:")]
        self.assertNotIn("ref: main", generate)
        self.assertIn("Fetch full Git evidence only when minimum history needs recovery", self.text)
        self.assertIn("minimum_history.assert_matches(history, prices)", self.text)
        self.assertIn("git fetch --unshallow origin main", self.text)
        self.assertNotIn("fetch-depth: 0", self.text)

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
        self.assertIn("--expected-minimum-history", self.text)
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
        self.assertIn("browser: [chromium, firefox, webkit]", validate)
        self.assertIn("pnpm install --frozen-lockfile --ignore-scripts", validate)
        self.assertIn("pnpm audit --audit-level low", validate)
        self.assertIn("PLAYWRIGHT_BROWSER:", validate)
        package = (ROOT / "tools" / "chatgpt_price_comparison" / "package.json").read_text(encoding="utf-8")
        lock = (ROOT / "tools" / "chatgpt_price_comparison" / "pnpm-lock.yaml").read_text(encoding="utf-8")
        self.assertIn('"playwright": "1.63.0"', package)
        self.assertIn("playwright@1.63.0", lock)
        for relative in ("app.js", "index.template.html", "scripts/pipeline.py", "scripts/browser-matrix.mjs"):
            project_file = (ROOT / "tools" / "chatgpt_price_comparison" / relative).read_text(encoding="utf-8")
            self.assertNotIn("icloud_price_comparison", project_file)

    def test_minimum_history_is_candidate_validated_and_published_atomically(self):
        self.assertIn("minimum-history.json", self.text)
        self.assertIn("Publish three files atomically", self.text)
        self.assertIn("git add tools/chatgpt_price_comparison/data/prices.json tools/chatgpt_price_comparison/data/minimum-history.json tools/chatgpt_price_comparison/index.html", self.text)

    def test_degraded_browser_states_are_exercised_offline(self):
        validate = (ROOT/'.github/workflows/validate-chatgpt-prices.yml').read_text(encoding='utf-8')
        self.assertIn('scripts/browser-state-fixtures.py',validate)

    def test_push_validation_verifies_real_pages_after_cross_browser_gate(self):
        validate = (ROOT / ".github" / "workflows" / "validate-chatgpt-prices.yml").read_text(encoding="utf-8")
        self.assertIn("production-smoke:", validate)
        self.assertIn("if: github.event_name == 'push'", validate)
        self.assertIn("needs: [tests, browser-matrix]", validate)
        self.assertIn("pages/builds/latest", validate)
        self.assertIn("--expected-minimum-history tools/chatgpt_price_comparison/data/minimum-history.json", validate)
        self.assertIn("--expected-index tools/chatgpt_price_comparison/index.html", validate)
        self.assertIn("SUPERSEDED_CHATGPT_BUILD", validate)
        self.assertIn('deployment_scope.py', validate)
        self.assertIn('case "$diff_status" in', validate)
        self.assertIn('exit "$diff_status"', validate)
        self.assertIn("steps.pages.outputs.should_verify == 'true'", validate)

    def test_full_update_verification_yields_to_newer_chatgpt_deployment(self):
        self.assertIn("published_sha: ${{ steps.push_data.outputs.pushed_sha }}", self.text)
        self.assertIn("PUBLISHED_SHA: ${{ needs.publish.outputs.published_sha }}", self.text)
        self.assertIn("SUPERSEDED_CHATGPT_UPDATE_VERIFY", self.text)
        self.assertIn("superseded: ${{ steps.freshness.outputs.superseded }}", self.text)
        self.assertIn("VERIFY_SUPERSEDED: ${{ needs.verify-production.outputs.superseded }}", self.text)
        self.assertIn("superseded_update=true", self.text)
        self.assertIn('"$VERIFY_SUPERSEDED" != true', self.text)
        self.assertIn("keep incident state unchanged", self.text)

    def test_supersession_fetches_publication_and_distinguishes_errors(self):
        self.assertIn('git fetch origin "$PUBLISHED_SHA" --depth=1', self.text)
        self.assertIn('--base "$PUBLISHED_SHA" --head "$current_main_sha"', self.text)
        self.assertIn('case "$diff_status" in', self.text)
        self.assertIn('exit "$diff_status"', self.text)
        self.assertNotIn('if ! git diff --quiet "$PUBLISHED_SHA"', self.text)

    def test_idempotent_backup_revalidates_current_production(self):
        self.assertIn("verify-existing-production:", self.text)
        self.assertIn("needs.prepare.outputs.should_run != 'true'", self.text)
        self.assertIn("needs.prepare.outputs.trigger_source != 'manual'", self.text)
        self.assertIn("ref: ${{ needs.prepare.outputs.validated_main_sha }}", self.text)
        self.assertIn("SUPERSEDED_CHATGPT_EXISTING_VERIFY", self.text)
        self.assertIn("--expected-minimum-history tools/chatgpt_price_comparison/data/minimum-history.json", self.text)
        self.assertIn("EXISTING_VERIFY: ${{ needs.verify-existing-production.result }}", self.text)
        self.assertIn("EXISTING_SUPERSEDED: ${{ needs.verify-existing-production.outputs.superseded }}", self.text)
        self.assertIn("superseded: ${{ steps.freshness.outputs.superseded }}", self.text)
        self.assertIn('echo "superseded=false" >> "$GITHUB_OUTPUT"', self.text)
        self.assertIn('echo "superseded=true" >> "$GITHUB_OUTPUT"', self.text)
        self.assertIn("superseded_skip=true", self.text)
        self.assertIn("keep incident state unchanged", self.text)
        self.assertIn("automatic_skip_ok=true", self.text)
        self.assertNotIn("SHOULD_RUN\" != true ]] ||", self.text)

    def test_only_main_can_publish(self):
        self.assertIn("github.ref == 'refs/heads/main'", self.text)
        self.assertNotIn("feat/chatgpt-price-comparison", self.text)


if __name__ == "__main__":
    unittest.main()
