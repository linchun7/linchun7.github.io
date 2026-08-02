import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeTriggerSource,
  findSuccessfulAutomaticRun,
  formatBeijingDate,
  isAutomaticTriggerSource,
  resolveTriggerSource
} from './run-context.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_LOG_PATH = path.join(PROJECT_DIR, 'data/run-log.json');

export function evaluateDailyRun({ runLog, eventName, requestedSource, now = new Date() }) {
  const triggerSource = resolveTriggerSource(eventName, requestedSource);
  const automatic = isAutomaticTriggerSource(triggerSource);
  const automaticRunDateBeijing = automatic ? formatBeijingDate(now) : null;
  const previousRun = automatic
    ? findSuccessfulAutomaticRun(runLog, automaticRunDateBeijing)
    : null;
  return {
    triggerSource,
    automaticRunDateBeijing,
    shouldRun: !previousRun,
    previousRun
  };
}

async function appendOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ''}\n`, 'utf8');
}

async function writeSkipSummary(result) {
  if (!process.env.GITHUB_STEP_SUMMARY || result.shouldRun) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, [
    '## iCloud+ 价格更新',
    '',
    '### 结论',
    '- **状态：已跳过重复自动更新**',
    `- 触发方式：${describeTriggerSource(result.triggerSource)}`,
    `- 北京时间日期：${result.automaticRunDateBeijing}`,
    `- 已成功运行：${result.previousRun.id}`,
    '- 数据、历史和运行日志均未重复写入。',
    ''
  ].join('\n'), 'utf8');
}

export async function main() {
  const runLog = JSON.parse(await readFile(RUN_LOG_PATH, 'utf8'));
  const result = evaluateDailyRun({
    runLog,
    eventName: process.env.GITHUB_EVENT_NAME,
    requestedSource: process.env.REQUESTED_TRIGGER_SOURCE
  });
  await appendOutput('should_run', String(result.shouldRun));
  await appendOutput('trigger_source', result.triggerSource);
  await appendOutput('automatic_run_date_beijing', result.automaticRunDateBeijing);
  await writeSkipSummary(result);
  console.log(result.shouldRun
    ? `${describeTriggerSource(result.triggerSource)}：允许执行。`
    : `${describeTriggerSource(result.triggerSource)}：${result.automaticRunDateBeijing} 已成功更新，本次跳过。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
