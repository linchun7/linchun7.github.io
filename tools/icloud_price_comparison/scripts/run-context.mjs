const AUTOMATIC_TRIGGER_SOURCES = new Set(['cloudflare', 'github-schedule']);
const KNOWN_TRIGGER_SOURCES = new Set([
  'cloudflare',
  'github-schedule',
  'schedule',
  'manual',
  'workflow_dispatch',
  'local'
]);

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function formatBeijingDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function resolveTriggerSource(eventName, requestedSource) {
  if (eventName === 'schedule') return 'github-schedule';
  if (eventName === 'workflow_dispatch') {
    return requestedSource === 'cloudflare' ? 'cloudflare' : 'manual';
  }
  if (KNOWN_TRIGGER_SOURCES.has(requestedSource)) return requestedSource;
  if (KNOWN_TRIGGER_SOURCES.has(eventName)) return eventName;
  return 'local';
}

export function describeTriggerSource(source) {
  const labels = {
    cloudflare: 'Cloudflare 定时主触发',
    'github-schedule': 'GitHub 定时备用',
    schedule: 'GitHub 定时备用',
    manual: '手动执行',
    workflow_dispatch: '手动执行',
    local: '本地执行'
  };
  return labels[source] ?? source ?? '未知';
}

export function isAutomaticTriggerSource(source) {
  return AUTOMATIC_TRIGGER_SOURCES.has(source);
}

function githubTimestampMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

export function findSuccessfulProductionWorkflowRun(
  runs,
  generatedAt,
  automaticRunDateBeijing,
  now = new Date()
) {
  if (!Array.isArray(runs) || !automaticRunDateBeijing || !isCanonicalIsoTimestamp(generatedAt)) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(generatedAtMs)) return null;
  return runs.find((run) => {
    const createdAtMs = githubTimestampMs(run?.created_at);
    const updatedAtMs = githubTimestampMs(run?.updated_at);
    return run?.conclusion === 'success'
      && run?.head_branch === 'main'
      && ['schedule', 'workflow_dispatch'].includes(run?.event)
      && formatBeijingDate(run.created_at) === automaticRunDateBeijing
      && Number.isFinite(createdAtMs)
      && Number.isFinite(updatedAtMs)
      && createdAtMs <= updatedAtMs
      && updatedAtMs >= generatedAtMs
      && createdAtMs <= nowMs
      && updatedAtMs <= nowMs;
  }) ?? null;
}

export function findSuccessfulAutomaticRun(runLog, automaticRunDateBeijing, now = new Date()) {
  if (!Array.isArray(runLog?.runs) || !automaticRunDateBeijing) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  return [...runLog.runs].reverse().find((run) => (
    run?.schemaVersion === 1
    && run?.id === run.finishedAtUtc
    && run.status === 'success'
    && isAutomaticTriggerSource(run.trigger)
    && run.automaticRunDateBeijing === automaticRunDateBeijing
    && run.observedAtBeijing === automaticRunDateBeijing
    && run.source?.exchangeRatesStale === false
    && formatBeijingDate(run.source?.exchangeRatesFetchedAtUtc) === automaticRunDateBeijing
    && formatBeijingDate(run.finishedAtUtc) === automaticRunDateBeijing
    && Number.isFinite(nowMs)
    && isCanonicalIsoTimestamp(run.startedAtUtc)
    && isCanonicalIsoTimestamp(run.finishedAtUtc)
    && isCanonicalIsoTimestamp(run.source?.exchangeRatesFetchedAtUtc)
    && Date.parse(run.startedAtUtc) <= Date.parse(run.finishedAtUtc)
    && Date.parse(run.startedAtUtc) <= nowMs
    && Date.parse(run.finishedAtUtc) <= nowMs
    && Date.parse(run.source.exchangeRatesFetchedAtUtc) <= nowMs
  )) ?? null;
}
