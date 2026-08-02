const AUTOMATIC_TRIGGER_SOURCES = new Set(['cloudflare', 'github-schedule']);

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
  return requestedSource || eventName || 'local';
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

export function findSuccessfulAutomaticRun(runLog, automaticRunDateBeijing) {
  if (!Array.isArray(runLog?.runs) || !automaticRunDateBeijing) return null;
  return [...runLog.runs].reverse().find((run) => (
    run?.status === 'success'
    && run.automaticRunDateBeijing === automaticRunDateBeijing
    && run.source?.exchangeRatesStale === false
    && formatBeijingDate(run.source?.exchangeRatesFetchedAtUtc) === automaticRunDateBeijing
  )) ?? null;
}
