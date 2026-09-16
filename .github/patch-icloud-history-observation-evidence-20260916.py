from pathlib import Path

validator = Path('tools/icloud_price_comparison/scripts/validate-data-artifact.mjs')
text = validator.read_text(encoding='utf-8')
old_event = """        const event = {
          observedAt: snapshot.publishedDate,
          currency: country.currency,
          plans: country.plans
        };"""
new_event = """        const event = {
          observedAtCandidates: [...new Set([snapshot.publishedDate, revision.firstConfirmedDate].filter(Boolean))],
          currency: country.currency,
          plans: country.plans
        };"""
if text.count(old_event) != 1:
    raise SystemExit(f'expected one event block, got {text.count(old_event)}')
text = text.replace(old_event, new_event, 1)

old_compare = """      if (actual.observedAt !== expected.observedAt
        || actual.currency !== expected.currency
        || !samePlans(actual.plans, expected.plans)) {"""
new_compare = """      if (!expected.observedAtCandidates.includes(actual.observedAt)
        || actual.currency !== expected.currency
        || !samePlans(actual.plans, expected.plans)) {"""
if text.count(old_compare) != 1:
    raise SystemExit(f'expected one comparison block, got {text.count(old_compare)}')
text = text.replace(old_compare, new_compare, 1)
validator.write_text(text, encoding='utf-8')

tests_path = Path('tools/icloud_price_comparison/test/validate-data-artifact.test.mjs')
tests = tests_path.read_text(encoding='utf-8')
marker = 'accepts only evidence-backed publication or first-confirmation dates for price history events'
if marker in tests:
    raise SystemExit('regression test already exists')
tests += """

test('accepts only evidence-backed publication or first-confirmation dates for price history events', () => {
  const snapshotIndex = {
    snapshots: [{
      publishedDate: '2026-09-15',
      revisions: [{ dataFile: 'new-market.json', firstConfirmedDate: '2026-09-16' }]
    }]
  };
  const normalizedSnapshots = new Map([[
    'new-market.json',
    { countries: [{ country: 'Afghanistan', currency: 'USD', plans: { '50GB': 0.99 } }] }
  ]]);
  const historyAtConfirmation = {
    markets: {
      'apple-afghanistan-5dbddf91': {
        country: 'Afghanistan',
        events: [{ observedAt: '2026-09-16', currency: 'USD', plans: { '50GB': 0.99 } }]
      }
    }
  };

  assert.doesNotThrow(() => validateHistoryAgainstSnapshotEvidence(
    historyAtConfirmation, snapshotIndex, normalizedSnapshots
  ));

  const backfilledAtPublication = structuredClone(historyAtConfirmation);
  backfilledAtPublication.markets['apple-afghanistan-5dbddf91'].events[0].observedAt = '2026-09-15';
  assert.doesNotThrow(() => validateHistoryAgainstSnapshotEvidence(
    backfilledAtPublication, snapshotIndex, normalizedSnapshots
  ));

  const ungroundedDate = structuredClone(historyAtConfirmation);
  ungroundedDate.markets['apple-afghanistan-5dbddf91'].events[0].observedAt = '2026-09-17';
  assert.throws(
    () => validateHistoryAgainstSnapshotEvidence(ungroundedDate, snapshotIndex, normalizedSnapshots),
    /history events do not match snapshot evidence/
  );
});
"""
tests_path.write_text(tests, encoding='utf-8')

docs = {
    Path('tools/icloud_price_comparison/README.md'): (
        '完整工件深验同样先把快照 source name 按 registry alias / deterministic identity 解析回 `marketId` 后核对价格事件。',
        '完整工件深验同样先把快照 source name 按 registry alias / deterministic identity 解析回 `marketId` 后核对价格事件；历史回填事件只允许锚定 Apple `Published Date`，在线首次确认事件只允许锚定对应 snapshot revision 的 `firstConfirmedDate`，不接受无证据的中间或更晚日期。'
    ),
    Path('tools/icloud_price_comparison/ARCHITECTURE.md'): (
        '完整 artifact 深验核对价格事件时也必须先把快照 source name 解析回稳定 `marketId`，不能用当前 `record.country` 反向拆分历史。',
        '完整 artifact 深验核对价格事件时也必须先把快照 source name 解析回稳定 `marketId`，不能用当前 `record.country` 反向拆分历史。价格事件日期同时受证据锚点约束：历史回填可使用该 revision 的 `publishedDate`，在线首次确认可使用 `firstConfirmedDate`；其他日期不得仅凭价格相同而通过。'
    ),
    Path('tools/icloud_price_comparison/OPERATIONS.md'): (
        '价格历史的 artifact 深验必须按解析后的稳定 `marketId` 对齐快照事件。',
        '价格历史的 artifact 深验必须按解析后的稳定 `marketId` 对齐快照事件，并要求事件日期精确命中 snapshot revision 的 `publishedDate`（历史回填）或 `firstConfirmedDate`（在线首次确认）之一。'
    )
}
for path, (before, after) in docs.items():
    doc = path.read_text(encoding='utf-8')
    if doc.count(before) != 1:
        raise SystemExit(f'unexpected doc anchor in {path}: {doc.count(before)}')
    path.write_text(doc.replace(before, after, 1), encoding='utf-8')
