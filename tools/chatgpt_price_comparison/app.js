'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const FRESH = 36 * 3600e3, EXPIRE = 7 * 86400e3;
  let data, loading = false, failure = '', lastRequest = 0;
  const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
  const date = s => new Date(s).toLocaleString('zh-CN', {hour12: false});
  const age = s => Date.now() - Date.parse(s);
  const usable = s => Number.isFinite(age(s)) && age(s) >= -300e3 && age(s) <= EXPIRE;
  const fresh = m => m.status === 'verified' && usable(m.last_verified_at) && age(m.last_verified_at) <= FRESH;
  const statuses = {verified: '已核验', retained: '抓取失败 · 沿用旧价', pending: '异常变动 · 待复核', unavailable: '暂无可核验标价'};
  function validate(value) {
    if (value.schema !== 1 || value.channel !== 'ios-app-store' || value.billing_period !== 'not_disclosed' || value.purchase_eligibility !== 'not_verified' || !/^[a-f0-9]{64}$/.test(value.revision) || !Number.isFinite(Date.parse(value.generated_at)) || !Array.isArray(value.markets) || !value.markets.length || value.markets.length > 250) throw Error('数据格式不匹配');
    const codes = new Set();
    for (const m of value.markets) {
      if (!/^[a-z]{2}$/.test(m.code) || codes.has(m.code) || m.source_url !== `https://apps.apple.com/${m.code}/app/chatgpt/id6448311069` || typeof m.name !== 'string' || m.name.length > 80 || !Object.hasOwn(statuses, m.status) || !Array.isArray(m.offers)) throw Error('地区数据不合法');
      codes.add(m.code);
      for (const o of m.offers) {
        if (typeof o.label !== 'string' || !o.label.startsWith('ChatGPT ') || o.label.length > 90 || !Array.isArray(o.amounts) || !o.amounts.length || o.amounts.length > 20 || !/^[A-Z]{3}$/.test(m.currency) || !Number.isFinite(Date.parse(m.last_verified_at))) throw Error('套餐数据不合法');
        for (const a of o.amounts) if (typeof a.amount !== 'string' || !/^\d+(\.\d{1,3})?$/.test(a.amount) || !Number.isFinite(Number(a.amount)) || Number(a.amount) <= 0 || typeof a.display !== 'string' || a.display.length > 80 || a.cny !== null && (typeof a.cny !== 'string' || !/^\d+\.\d{2}$/.test(a.cny))) throw Error('金额格式错误');
      }
    }
    if (value.fx && (value.fx.source_url !== 'https://open.er-api.com/v6/latest/USD' || !Number.isFinite(Date.parse(value.fx.updated_at)) || !value.fx.rates || Number(value.fx.rates.USD) !== 1 || !(Number(value.fx.rates.CNY) > 1 && Number(value.fx.rates.CNY) < 30) || Object.values(value.fx.rates).some(r => !Number.isFinite(Number(r)) || Number(r) <= 0))) throw Error('汇率数据不合法');
    if (!Array.isArray(value.changes) || value.changes.length > 200 || value.changes.some(c => !/^[a-z]{2}$/.test(c.code) || !Number.isFinite(Date.parse(c.at)) || [c.before,c.after].some(s => !s || !/^[A-Z]{3}$/.test(s.currency) || !Array.isArray(s.offers) || s.offers.some(o => typeof o.label !== 'string' || !Array.isArray(o.amounts) || o.amounts.some(a => typeof a !== 'string'))))) throw Error('历史格式错误');
    return value;
  }
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  function cny(m, a) {
    const fx = data.fx;
    if (!fx || !usable(fx.updated_at) || !usable(m.last_verified_at) || !fx.rates[m.currency] || a.cny === null) return '—';
    return '¥' + (Number(a.cny)).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  }
  function render() {
    const query = $('search').value.normalize('NFKC').trim().toLowerCase().slice(0, 80), selected = $('plan').value, status = $('status').value;
    const fragment = document.createDocumentFragment();
    let rows = 0, countries = 0;
    for (const m of data.markets) {
      if (query && !`${m.name} ${m.code} ${m.currency || ''}`.toLowerCase().includes(query)) continue;
      if (status === 'fresh' && !fresh(m) || status === 'attention' && fresh(m)) continue;
      const offers = m.offers.filter(o => !selected || o.label === selected);
      if (!offers.length && m.offers.length) continue;
      if (!offers.length && selected) continue;
      countries++;
      for (const o of offers.length ? offers : [null]) {
        rows++;
        const tr = node('tr'), th = node('th'); th.scope = 'row';
        const link = node('a', m.name); link.href = m.source_url; link.rel = 'noopener noreferrer'; th.append(link, node('small', `${m.code.toUpperCase()} · ${m.currency || '—'}`)); tr.append(th);
        const plan = node('td', o ? o.label : '—'); plan.append(node('small', o && o.amounts.length > 1 ? '多个同名标价，周期未披露' : '周期未披露')); tr.append(plan);
        for (const converted of [false, true]) {
          const td = node('td', undefined, 'number');
          for (const a of o ? o.amounts : []) td.append(node('div', converted ? cny(m, a) : a.display));
          if (!o) td.textContent = '—'; tr.append(td);
        }
        const td = node('td', !m.offers.length ? statuses.unavailable : !usable(m.last_verified_at) ? '超过 7 天或时间异常' : age(m.last_verified_at) > FRESH ? '旧价参考 · ' + statuses[m.status] : statuses[m.status], fresh(m) ? '' : 'warning');
        td.append(node('small', m.last_verified_at ? date(m.last_verified_at) : '不代表该地区不受支持')); tr.append(td); fragment.append(tr);
      }
    }
    $('price-rows').replaceChildren(fragment); $('empty').hidden = rows !== 0;
    $('result-count').textContent = `${countries} 个地区 · ${rows} 行标价项目。周期未经确认，不计算月费排名或“最便宜国家”。`;
    $('generated').textContent = date(data.generated_at);
    $('coverage').textContent = `${data.markets.filter(m => m.offers.length).length} / ${data.markets.length}`;
    const fx = data.fx;
    $('fx-status').textContent = !fx ? '不可用：仅显示当地标价' : !usable(fx.updated_at) ? '已过期：不再换算' : `${fx.fallback || age(fx.updated_at) > FRESH ? '沿用旧汇率 · ' : ''}${date(fx.updated_at)}`;
    const stale = data.markets.filter(m => m.offers.length && !fresh(m)).length;
    const uncertain = data.markets.filter(m => !m.offers.length).length;
    $('health').textContent = [failure, !usable(data.generated_at) ? '本页数据已过期或系统时间异常；请勿视为现价。' : `每地区独立核验：${stale} 个地区为旧价或待复核，${uncertain} 个地区暂无可核验标价。`, fx && (fx.fallback || age(fx.updated_at) > FRESH) ? '人民币使用旧汇率，仅供参考。' : ''].filter(Boolean).join(' ');
    $('health').className = failure || stale || !fx || !usable(data.generated_at) || fx.fallback || age(fx.updated_at) > FRESH ? 'warning' : '';
  }
  function install(next) {
    data = validate(next);
    const current = $('plan').value, labels = [...new Set(data.markets.flatMap(m => m.offers.map(o => o.label)))].sort();
    $('plan').replaceChildren(new Option('全部公开套餐', ''));
    labels.forEach(label => $('plan').add(new Option(label, label)));
    $('plan').value = labels.includes(current) ? current : '';
    const changes = document.createDocumentFragment();
    for (const item of [...data.changes].reverse()) {
      const show = side => `${side.currency} ` + side.offers.map(o => `${o.label}: ${o.amounts.join(' / ')}`).join('；');
      changes.append(node('p', `${date(item.at)} · ${item.code.toUpperCase()}\n${show(item.before)} → ${show(item.after)}`));
    }
    if (!data.changes.length) changes.append(node('p', '自开始记录以来，尚未观察到已确认的标价变化。汇率变化不算套餐改价。'));
    $('changes').replaceChildren(changes); $('filters').hidden = false; render();
  }
  async function refresh() {
    if (loading) return;
    loading = true; lastRequest = Date.now(); $('refresh').disabled = true;
    try {
      const response = await fetch(`data/prices.json?t=${Date.now()}`, {cache: 'no-store', signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw Error('HTTP ' + response.status);
      const text = await response.text(); if (text.length > 2e6) throw Error('数据超过大小限制');
      const next = validate(JSON.parse(text));
      const {revision, ...payload} = next;
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(payload))))].map(x => x.toString(16).padStart(2, '0')).join('');
      if (revision !== hash) throw Error('数据完整性校验失败');
      if (!usable(next.generated_at) || Date.parse(next.generated_at) < Date.parse(data.generated_at)) throw Error('返回过期、未来或倒退的数据');
      failure = ''; install(next);
    } catch (error) {
      failure = '重新加载未成功，保留本页原数据；请核对核验时间。';
      render();
    } finally { loading = false; $('refresh').disabled = false; }
  }
  try {
    install(JSON.parse($('price-data').textContent));
    $('plan').value = [...$('plan').options].some(o => o.value === 'ChatGPT Plus') ? 'ChatGPT Plus' : '';
    render();
    $('filters').addEventListener('submit', e => e.preventDefault());
    for (const id of ['plan','search','status']) $(id).addEventListener(id === 'search' ? 'input' : 'change', render);
    $('refresh').addEventListener('click', refresh);
    setInterval(render, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); if (Date.now() - lastRequest > 300000) refresh(); } });
    refresh();
  } catch (error) { $('health').textContent = '交互功能未能启动。下方保留静态标价，请核对 UTC 核验时间。'; $('health').className = 'warning'; }
})();
