import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class IncidentNotificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[3]
        workflow = (root/'.github/workflows/update-chatgpt-prices.yml').read_text()
        block = workflow.split('      - name: Maintain one incident issue and close it after recovery\n', 1)[1]
        block = block.split('        run: |\n', 1)[1]
        cls.script = '\n'.join(line[10:] if line.startswith('          ') else line for line in block.splitlines())
        assert '${{' not in cls.script

    def run_notification(self, existing='150', **overrides):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            gh = root/'gh'
            gh.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
if args[:2] == ['issue','list']:
    print(os.environ['EXISTING_ISSUE'])
else:
    body=Path(args[args.index('--body-file')+1]).read_text() if '--body-file' in args else ''
    with open(os.environ['CALLS'],'a') as stream:
        stream.write(json.dumps({'args':args,'body':body})+'\\n')
""")
            gh.chmod(0o755)
            env = dict(os.environ, PATH=str(root)+os.pathsep+os.environ.get('PATH',''),
                       EXISTING_ISSUE=existing, CALLS=str(root/'calls'),
                       PREPARE='success', GENERATE='success', PUBLISH='success', VERIFY='success',
                       VERIFY_SUPERSEDED='false', DEGRADED='true', SHOULD_RUN='true',
                       TRIGGER_SOURCE='manual', EXISTING_VERIFY='skipped', EXISTING_SUPERSEDED='false',
                       PREPARE_STAGE='', GENERATE_STAGE='', PUBLISH_STAGE='', SOURCE_SUMMARY='待复核 2；us:plan_added',
                       GITHUB_SERVER_URL='https://github.com', GITHUB_REPOSITORY='example/repo',
                       GITHUB_RUN_ID='42', GITHUB_RUN_ATTEMPT='2')
            env.update(overrides)
            result = subprocess.run(['bash','-c',self.script], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return [json.loads(line) for line in (root/'calls').read_text().splitlines()] if (root/'calls').exists() else []

    def test_existing_failure_updates_latest_body_without_comment(self):
        calls = self.run_notification()
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['args'][:3],['issue','edit','150'])
        self.assertIn('/actions/runs/42', calls[0]['body'])
        self.assertIn('plan_added', calls[0]['body'])
        self.assertIn('不绕过确认窗口', calls[0]['body'])

    def test_first_failure_creates_issue(self):
        self.assertEqual(self.run_notification(existing='')[0]['args'][:2], ['issue','create'])

    def test_only_full_recovery_closes(self):
        self.assertEqual(self.run_notification(DEGRADED='false')[0]['args'][:2], ['issue','close'])
        self.assertEqual(self.run_notification(SHOULD_RUN='false', TRIGGER_SOURCE='cloudflare', EXISTING_VERIFY='success')[0]['args'][:2], ['issue','close'])
        self.assertEqual(self.run_notification()[0]['args'][:2], ['issue','edit'])

    def test_superseded_runs_do_not_change_incident(self):
        self.assertEqual(self.run_notification(VERIFY_SUPERSEDED='true'), [])
        self.assertEqual(self.run_notification(SHOULD_RUN='false',TRIGGER_SOURCE='cloudflare',EXISTING_VERIFY='success',EXISTING_SUPERSEDED='true'), [])

    def test_stage_specific_next_action(self):
        for environment, label in [
            ({'PREPARE':'failure','PREPARE_STAGE':'准备/工作流版本'},'准备/工作流版本'),
            ({'GENERATE':'failure','GENERATE_STAGE':'来源采集或数据校验'},'来源采集或数据校验'),
            ({'GENERATE':'failure','GENERATE_STAGE':'离线回归测试'},'离线回归测试'),
            ({'GENERATE':'failure','GENERATE_STAGE':'候选或浏览器验收'},'候选或浏览器验收'),
            ({'PUBLISH':'failure','PUBLISH_STAGE':'Pages 部署'},'Pages 部署'),
            ({'VERIFY':'failure'},'线上生产验证'),
        ]:
            with self.subTest(label=label):
                self.assertIn(label, self.run_notification(**environment)[0]['body'])

    def test_summary_is_literal_data_not_shell_code(self):
        value = '$HOME $(printf injected) `printf injected` ; @example'
        self.assertIn(value, self.run_notification(SOURCE_SUMMARY=value)[0]['body'])


if __name__ == '__main__':
    unittest.main()
