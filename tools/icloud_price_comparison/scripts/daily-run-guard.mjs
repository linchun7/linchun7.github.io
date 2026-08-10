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

export async function readRunLog(filePath = RUN_LOG_PATH) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { schemaVersion: 1, retention: 90, runs: [] };
    }
    throw error;
  }
}

export function evaluateDailyRun({ runLog, eventName, requestedSource, now = new Date() }) {
  const triggerSource = resolveTriggerSource(eventName, requestedSource);
  const automatic = isAutomaticTriggerSource(triggerSource);
  const automaticRunDateBeijing = automatic ? formatBeijingDate(now) : null;
  const previousRun = automatic
    ? findSuccessfulAutomaticRun(runLog, automaticRunDateBeijing, now)
    : null;
  return {
    triggerSource,
    automaticRunDateBeijing,
    shouldRun: !previousRun,
    previousRun
  };
}

async function appendOutput(name, value, outputPath) {
  if (!outputPath) return;
  await appendFile(outputPath, `${name}=${value ?? ''}\n`, 'utf8');
}

async function writeSkipSummary(result, summaryPath) {
  if (!summaryPath || result.shouldRun) return;
  await appendFile(summaryPath, [
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

export async function main({
  runLogPath = process.env.ICLOUD_RUN_LOG_PATH ?? RUN_LOG_PATH,
  eventName = process.env.GITHUB_EVENT_NAME,
  requestedSource = process.env.REQUESTED_TRIGGER_SOURCE,
  now = new Date(),
  outputPath = process.env.GITHUB_OUTPUT,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  log = console.log
} = {}) {
  const runLog = await readRunLog(runLogPath);
  const result = evaluateDailyRun({
    runLog,
    eventName,
    requestedSource,
    now
  });
  await appendOutput('should_run', String(result.shouldRun), outputPath);
  await appendOutput('trigger_source', result.triggerSource, outputPath);
  await appendOutput('automatic_run_date_beijing', result.automaticRunDateBeijing, outputPath);
  await writeSkipSummary(result, summaryPath);
  log(result.shouldRun
    ? `${describeTriggerSource(result.triggerSource)}：允许执行。`
    : `${describeTriggerSource(result.triggerSource)}：${result.automaticRunDateBeijing} 已成功更新，本次跳过。`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
