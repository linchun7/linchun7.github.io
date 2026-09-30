import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = Path(__file__).resolve().parent


class ProductionRecheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (ROOT / '.github/workflows/update-chatgpt-prices.yml').read_text()
        cls.validation = (ROOT / '.github/workflows/validate-chatgpt-prices.yml').read_text()
        blocks = (cls.workflow + '\n\n' + cls.validation).split('      - name: Recheck supersession after failed production verification\n')[1:]
        cls.rechecks = []
        for block in blocks:
            raw = block.split('        run: |\n', 1)[1].split('\n\n', 1)[0]
            cls.rechecks.append('\n'.join(line[10:] for line in raw.splitlines()))

    def git(self, cwd, *args):
        return subprocess.check_output(['git', *args], cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()

    def commit(self, repo, filename, content):
        path = repo / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        self.git(repo, 'add', '.')
        self.git(repo, '-c', 'commit.gpgSign=false', 'commit', '-m', 'Fixture update')
        return self.git(repo, 'rev-parse', 'HEAD')

    def test_both_verifiers_keep_failure_until_explicit_recheck(self):
        self.assertEqual(len(self.rechecks), 3)
        self.assertEqual(self.rechecks[0], self.rechecks[1])
        self.assertEqual(self.rechecks[0], self.rechecks[2])
        self.assertEqual(self.workflow.count('id: verification\n        continue-on-error: true'), 2)
        self.assertEqual(self.workflow.count("if: ${{ !cancelled() && steps.verification.outcome == 'failure' }}"), 2)
        self.assertEqual(self.workflow.count('superseded: ${{ steps.recheck.outputs.superseded || steps.freshness.outputs.superseded }}'), 2)
        self.assertIn('id: verification\n        continue-on-error: true', self.validation)
        self.assertIn("if: ${{ !cancelled() && steps.verification.outcome == 'failure' }}", self.validation)
        self.assertIn('BASE_SHA: ${{ github.sha }}', self.validation)
        production = self.validation.split('  production-smoke:', 1)[1]
        self.assertIn('timeout-minutes: 15', production)

    def test_only_real_project_successor_can_supersede_failure(self):
        for scenario in ('unchanged', 'unrelated', 'project-change', 'missing-base', 'comparison-error'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                origin = root / 'origin'
                origin.mkdir()
                self.git(origin, 'init', '-b', 'main')
                self.git(origin, 'config', 'gc.auto', '0')
                self.git(origin, 'config', 'user.name', 'Fixture')
                self.git(origin, 'config', 'user.email', 'fixture@example.invalid')
                helper = 'tools/chatgpt_price_comparison/scripts/deployment_scope.py'
                baseline = self.commit(origin, helper, (SCRIPTS / 'deployment_scope.py').read_text())
                checkout = root / 'checkout'
                self.git(root, 'clone', '--depth=1', origin.as_uri(), str(checkout))
                if scenario in ('project-change', 'comparison-error'):
                    self.commit(origin, 'tools/chatgpt_price_comparison/app.js', 'new version')
                elif scenario == 'unrelated':
                    self.commit(origin, 'unrelated.txt', 'other project')
                if scenario == 'comparison-error':
                    (checkout / helper).write_text('raise SystemExit(2)\n')
                output = root / 'outputs'
                result = subprocess.run(
                    ['bash', '-c', self.rechecks[0]], cwd=checkout, text=True, capture_output=True,
                    env={**os.environ, 'BASE_SHA': 'f' * 40 if scenario == 'missing-base' else baseline, 'GITHUB_OUTPUT': str(output)},
                )
                text = output.read_text() if output.exists() else ''
                if scenario == 'project-change':
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn('superseded=true', text)
                else:
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertNotIn('superseded=true', text)


if __name__ == '__main__':
    unittest.main()
