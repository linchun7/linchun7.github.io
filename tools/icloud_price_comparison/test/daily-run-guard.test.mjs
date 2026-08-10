import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateDailyRun, main, readRunLog } from '../scripts/daily-run-guard.mjs';
import {
  findSuccessfulAutomaticRun,
  formatBeijingDate,
  resolveTriggerSource
} from '../scripts/run-context.mjs';

function run({
  id = '2026-08-02T00:06:00.000Z',
  date = '2026-08-02',
  fetchedAt = '2026-08-02T00:00:01.000Z',
  stale = false,
  status = 'success'
} = {}) {
  return {
    schemaVersion: 1,
    id,
    status,
    startedAtUtc: '2026-08-02T00:05:00.000Z',
    finishedAtUtc: id,
    trigger: 'cloudflare',
    automaticRunDateBeijing: date,
    observedAtBeijing: date,
    source: {
      exchangeRatesFetchedAtUtc: fetchedAt,
      exchangeRatesStale: stale
    }
  };
}

test('resolves Cloudflare, GitHub backup, and manual trigger sources', () => {
  assert.equal(resolveTriggerSource('workflow_dispatch', 'cloudflare'), 'cloudflare');
  assert.equal(resolveTriggerSource('schedule', 'cloudflare'), 'github-schedule');
  assert.equal(resolveTriggerSource('workflow_dispatch', 'manual'), 'manual');
  assert.equal(resolveTriggerSource(undefined, undefined), 'local');
  assert.equal(resolveTriggerSource('push', 'evil\nshould_run=false'), 'local');
});

test('uses Beijing calendar dates at the UTC day boundary', () => {
  assert.equal(formatBeijingDate('2026-08-01T15:59:59.000Z'), '2026-08-01');
  assert.equal(formatBeijingDate('2026-08-01T16:00:00.000Z'), '2026-08-02');
  assert.equal(formatBeijingDate('invalid'), null);
});

test('skips a repeated automatic run only after fresh rates were committed', () => {
  const result = evaluateDailyRun({
    runLog: { schemaVersion: 1, runs: [run()] },
    eventName: 'schedule',
    now: new Date('2026-08-02T00:10:00.000Z')
  });
  assert.equal(result.triggerSource, 'github-schedule');
  assert.equal(result.automaticRunDateBeijing, '2026-08-02');
  assert.equal(result.shouldRun, false);
  assert.equal(result.previousRun.id, '2026-08-02T00:06:00.000Z');
});

test('reruns when a same-day automatic run has future exchange-rate data', () => {
  const now = new Date('2026-08-02T00:10:00.000Z');
  const result = evaluateDailyRun({
    runLog: { schemaVersion: 1, runs: [run({ fetchedAt: '2026-08-02T02:00:00.000Z' })] },
    eventName: 'schedule',
    now
  });
  assert.equal(formatBeijingDate('2026-08-02T02:00:00.000Z'), '2026-08-02');
  assert.equal(result.shouldRun, true);
  assert.equal(result.previousRun, null);
});

test('reruns when a same-day success record has future run timestamps', () => {
  const futureRun = run();
  futureRun.startedAtUtc = '2026-08-02T02:00:00.000Z';
  futureRun.finishedAtUtc = '2026-08-02T02:01:00.000Z';
  const result = evaluateDailyRun({
    runLog: { schemaVersion: 1, runs: [futureRun] },
    eventName: 'schedule',
    now: new Date('2026-08-02T00:10:00.000Z')
  });
  assert.equal(result.shouldRun, true);
  assert.equal(result.previousRun, null);
});

test('reruns when the earlier automatic run used stale or previous-day rates', () => {
  for (const previousRun of [
    run({ stale: true }),
    run({ fetchedAt: '2026-08-01T00:02:31.000Z' }),
    run({ status: 'failure' }),
    run({ date: '2026-08-01', fetchedAt: '2026-08-01T00:02:31.000Z' })
  ]) {
    const result = evaluateDailyRun({
      runLog: { schemaVersion: 1, runs: [previousRun] },
      eventName: 'schedule',
      now: new Date('2026-08-02T00:10:00.000Z')
    });
    assert.equal(result.shouldRun, true, JSON.stringify(previousRun));
  }
});

test('manual runs are always allowed and do not create an automatic date', () => {
  const result = evaluateDailyRun({
    runLog: { schemaVersion: 1, runs: [run()] },
    eventName: 'workflow_dispatch',
    requestedSource: 'manual',
    now: new Date('2026-08-02T02:00:00.000Z')
  });
  assert.equal(result.triggerSource, 'manual');
  assert.equal(result.automaticRunDateBeijing, null);
  assert.equal(result.shouldRun, true);
});

test('ignores malformed and legacy run records', () => {
  assert.equal(findSuccessfulAutomaticRun(null, '2026-08-02'), null);
  assert.equal(findSuccessfulAutomaticRun({ runs: [{ status: 'success' }] }, '2026-08-02'), null);
  assert.equal(findSuccessfulAutomaticRun({ runs: [{ ...run(), trigger: 'manual' }] }, '2026-08-02'), null);
  assert.equal(findSuccessfulAutomaticRun({ runs: [{ ...run(), id: '[link](https://evil.example)' }] }, '2026-08-02'), null);
  assert.equal(findSuccessfulAutomaticRun({ runs: [{ ...run(), observedAtBeijing: '2026-08-01' }] }, '2026-08-02'), null);
  assert.equal(findSuccessfulAutomaticRun({ runs: [{ ...run(), schemaVersion: 0 }] }, '2026-08-02'), null);
});

test('allows recovery when the run log is missing but rejects malformed JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'icloud-run-guard-'));
  try {
    const missingPath = path.join(directory, 'missing.json');
    assert.deepEqual(await readRunLog(missingPath), { schemaVersion: 1, retention: 90, runs: [] });

    const malformedPath = path.join(directory, 'malformed.json');
    await writeFile(malformedPath, '{not-json', 'utf8');
    await assert.rejects(() => readRunLog(malformedPath), SyntaxError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('writes deterministic GitHub outputs and a safe duplicate-run summary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'icloud-run-guard-cli-'));
  const runLogPath = path.join(directory, 'run-log.json');
  const outputPath = path.join(directory, 'output.txt');
  const summaryPath = path.join(directory, 'summary.md');
  const messages = [];
  try {
    await writeFile(runLogPath, `${JSON.stringify({ schemaVersion: 1, retention: 90, runs: [run()] })}\n`, 'utf8');
    const result = await main({
      runLogPath,
      eventName: 'schedule',
      now: new Date('2026-08-02T00:10:00.000Z'),
      outputPath,
      summaryPath,
      log: (message) => messages.push(message)
    });
    assert.equal(result.shouldRun, false);
    assert.equal(await readFile(outputPath, 'utf8'), [
      'should_run=false',
      'trigger_source=github-schedule',
      'automatic_run_date_beijing=2026-08-02',
      ''
    ].join('\n'));
    const summary = await readFile(summaryPath, 'utf8');
    assert.match(summary, /状态：已跳过重复自动更新/);
    assert.match(summary, /已成功运行：2026-08-02T00:06:00\.000Z/);
    assert.deepEqual(messages, ['GitHub 定时备用：2026-08-02 已成功更新，本次跳过。']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
