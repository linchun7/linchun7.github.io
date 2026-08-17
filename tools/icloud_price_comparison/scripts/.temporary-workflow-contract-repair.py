from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TEST = ROOT / 'tools' / 'icloud_price_comparison' / 'test' / 'workflow.test.mjs'
text = TEST.read_text(encoding='utf-8')
old = """  assert.match(ciWorkflow, /run: pnpm audit --audit-level low/);
  assert.match(coreJob, /run: git diff --check/);
  assert.match(coreJob, /name: 强制关键架构更新同步文档[\\s\\S]*?if: github\\.event_name == 'pull_request'/);
  assert.match(coreJob, /fetch-depth: 0/);
"""
new = """  assert.match(ciWorkflow, /run: pnpm audit --audit-level low/);
  assert.match(coreJob, /name: 强制关键架构更新同步文档[\\s\\S]*?if: github\\.event_name == 'pull_request'/);
  const docsGate = coreJob.match(/- name: 强制关键架构更新同步文档[\\s\\S]*?(?=\\n      - name: 强制已发布 marketId 永久保留)/)?.[0] ?? '';
  assert.match(docsGate, /data-model\\.js/);
  assert.doesNotMatch(docsGate, /tools\\/icloud_price_comparison\\/script\\.js/);
  assert.match(coreJob, /name: 强制已发布 marketId 永久保留[\\s\\S]*?git['\"], \\['show'[\\s\\S]*?Published marketId removed from history ledger[\\s\\S]*?Published source identity rekeyed/);
  assert.match(coreJob, /name: 检查已提交 PR 差异格式[\\s\\S]*?if: github\\.event_name == 'pull_request'[\\s\\S]*?git diff --check \\\"\\$BASE_SHA\\\" HEAD/);
  assert.match(coreJob, /name: 检查工作区差异格式[\\s\\S]*?if: github\\.event_name != 'pull_request'[\\s\\S]*?run: git diff --check/);
  assert.match(coreJob, /fetch-depth: 0/);
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one workflow contract block, found {text.count(old)}')
TEST.write_text(text.replace(old, new, 1), encoding='utf-8')
print('workflow contract updated')
