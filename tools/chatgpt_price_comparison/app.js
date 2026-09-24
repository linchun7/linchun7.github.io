'use strict';

(() => {
  const FRESH = 36 * 3600e3;
  const EXPIRE = 7 * 86400e3;
  const ORDER = ['ChatGPT Go', 'ChatGPT Plus', 'ChatGPT Pro 5x', 'ChatGPT Pro 20x'];
  const STATUS = { verified: '已核验', retained: '沿用旧价', pending: '待复核', unavailable: '暂无标价' };
  const $ = (id) => document.getElementById(id);
  const el = {
    updatedAt: $('updatedAt'), freshnessWarning: $('freshnessWarning'),
    minimumSummary: $('minimumSummary'), marketCount: $('marketCount'),
    currencyCount: $('currencyCount'), planCount: $('planCount'),
    resultSummary: $('resultSummary'), rankHeaderLabel: $('rankHeaderLabel'), searchInput: $('searchInput'),
    mobilePlanControl: $('mobilePlanControl'), priceRows: $('priceRows'),
    emptyState: $('emptyState'), fxStatus: $('fxStatus'),
    historyDialog: $('historyDialog'), historyTitle: $('historyTitle'),
    historySubtitle: $('historySubtitle'), historyLocalPrice: $('historyLocalPrice'),
    historyCnyPrice: $('historyCnyPrice'), historyEventCount: $('historyEventCount'),
    historyPlanControl: $('historyPlanControl'), historyPlanHeader: $('historyPlanHeader'),
    historyRows: $('historyRows'), closeHistory: $('closeHistory'),
    backToTableButton: $('backToTableButton'), priceWorkspace: $('priceWorkspace'),
  };
  const state = {
    data: null, plans: [], query: '', sortKey: 'plan', sortPlan: null,
    sortDirection: 'asc', activePlan: null, minimums: new Map(),
    ranks: new Map(), activeMarket: null, historyPlan: null,
    historyReturnFocus: null, highlightTimer: null, scrollFrame: null,
  };

  const canonical = (value) => Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
  const age = (value) => Date.now() - Date.parse(value);
  const usable = (value) => Number.isFinite(age(value)) && age(value) >= -300e3 && age(value) <= EXPIRE;
  const fresh = (market) => market.status === 'verified' && usable(market.last_verified_at) && age(market.last_verified_at) <= FRESH;
  const shortPlan = (label) => label.replace(/^ChatGPT\s+/, '');
  const dateTime = (value) => new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  let createIcons = null;

  async function loadIcons() {
    try {
      const preload = document.querySelector('link[rel="modulepreload"][href*="lucide-subset.js?v="]');
      const version = preload ? new URL(preload.href, location.href).searchParams.get('v') : '';
      if (!/^[a-f0-9]{12}$/.test(version || '')) throw new Error('图标版本无效');
      const module = await import(`../icloud_price_comparison/vendor/lucide-subset.js?v=${version}`);
      createIcons = module.createIcons;
      refreshIcons();
    } catch (error) {
      console.warn(`图标加载失败：${error.message}`);
    }
  }

  function refreshIcons() {
    if (!createIcons) return;
    try {
      createIcons({ attrs: { 'stroke-width': 1.8 } });
    } catch (error) {
      console.warn(`图标渲染失败：${error.message}`);
    }
  }

  function mobileRankAccessibilityText(displayedRank) {
    if (displayedRank === '—' || displayedRank == null) return '排名暂不可用';
    return state.sortKey === 'country'
      ? `当前列表序号第 ${displayedRank}`
      : `全球价格排名第 ${displayedRank}`;
  }

  function updateRankingPresentation() {
    if (!el.rankHeaderLabel) return;
    el.rankHeaderLabel.replaceChildren();
    const visible = document.createElement('span');
    visible.setAttribute('aria-hidden', 'true');
    const accessible = document.createElement('span');
    accessible.className = 'visually-hidden';
    if (state.sortKey === 'country') {
      visible.textContent = '序号';
      accessible.textContent = '当前列表序号';
    } else {
      visible.textContent = '排名';
      accessible.textContent = '全球参考排名';
    }
    el.rankHeaderLabel.append(visible, accessible);
  }

  function replaceSortIcon(button, active) {
    const existing = button?.querySelector('i, svg');
    if (!existing) return;
    const icon = document.createElement('i');
    icon.dataset.lucide = active
      ? (state.sortDirection === 'asc' ? 'arrow-up' : 'arrow-down')
      : 'arrow-up-down';
    icon.setAttribute('aria-hidden', 'true');
    existing.replaceWith(icon);
  }

  function validateHistorySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || Object.keys(snapshot).sort().join(',') !== 'currency,offers'
      || !/^[A-Z]{3}$/.test(snapshot.currency || '')
      || !Array.isArray(snapshot.offers) || snapshot.offers.length < 1 || snapshot.offers.length > 40) {
      throw Error('历史快照格式错误');
    }
    const labels = new Set();
    for (const offer of snapshot.offers) {
      if (!offer || typeof offer !== 'object' || Array.isArray(offer)
        || Object.keys(offer).sort().join(',') !== 'amounts,label'
        || typeof offer.label !== 'string'
        || !/^ChatGPT [^\x00-\x1f\x7f<>]{1,70}$/.test(offer.label)
        || labels.has(offer.label)
        || !Array.isArray(offer.amounts) || offer.amounts.length < 1 || offer.amounts.length > 20) {
        throw Error('历史套餐格式错误');
      }
      labels.add(offer.label);
      let previous = -Infinity;
      for (const amount of offer.amounts) {
        if (typeof amount !== 'string' || !/^\d+(\.\d{1,3})?$/.test(amount)) throw Error('历史金额格式错误');
        const numeric = Number(amount);
        if (!Number.isFinite(numeric) || numeric <= previous) throw Error('历史金额顺序错误');
        previous = numeric;
      }
    }
  }

  function validate(value) {
    if (value?.schema !== 1 || value.channel !== 'ios-app-store'
      || value.billing_period !== 'not_disclosed' || value.purchase_eligibility !== 'not_verified'
      || !/^[a-f0-9]{64}$/.test(value.revision || '') || !Number.isFinite(Date.parse(value.generated_at))
      || !Array.isArray(value.markets) || !value.markets.length || value.markets.length > 250) throw Error('数据格式不匹配');
    const codes = new Set();
    for (const market of value.markets) {
      if (!/^[a-z]{2}$/.test(market.code) || codes.has(market.code)
        || market.source_url !== `https://apps.apple.com/${market.code}/app/chatgpt/id6448311069`
        || typeof market.name !== 'string' || !market.name || !Object.hasOwn(STATUS, market.status)
        || !Array.isArray(market.offers)) throw Error('地区数据不合法');
      codes.add(market.code);
      for (const offer of market.offers) {
        if (typeof offer.label !== 'string'
          || !/^ChatGPT [^\x00-\x1f\x7f<>]{1,70}$/.test(offer.label)
          || !Array.isArray(offer.amounts) || !offer.amounts.length) throw Error('套餐数据不合法');
        for (const amount of offer.amounts) {
          if (typeof amount.amount !== 'string' || !/^\d+(\.\d{1,3})?$/.test(amount.amount)
            || typeof amount.display !== 'string'
            || (amount.cny != null && (typeof amount.cny !== 'string' || !/^\d+\.\d{2}$/.test(amount.cny)))) throw Error('金额格式错误');
        }
      }
    }
    if (!Array.isArray(value.changes) || value.changes.length > 200) throw Error('历史格式错误');
    let previousChangeAt = -Infinity;
    const generatedAt = Date.parse(value.generated_at);
    for (const change of value.changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change)
        || Object.keys(change).sort().join(',') !== 'after,at,before,code'
        || !/^[a-z]{2}$/.test(change.code || '') || !codes.has(change.code)) throw Error('历史记录格式错误');
      const changedAt = Date.parse(change.at);
      if (!Number.isFinite(changedAt) || changedAt > generatedAt || changedAt < previousChangeAt) throw Error('历史时间错误');
      previousChangeAt = changedAt;
      validateHistorySnapshot(change.before);
      validateHistorySnapshot(change.after);
      if (canonical(change.before) === canonical(change.after)) throw Error('历史记录无变化');
    }
    return value;
  }

  async function verifyRevision(value) {
    if (!crypto?.subtle) return;
    const { revision, ...payload } = value;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(payload))))]
      .map((item) => item.toString(16).padStart(2, '0')).join('');
    if (hash !== revision) throw Error('数据完整性校验失败');
  }

  function orderedPlans() {
    const labels = [...new Set(state.data.markets.flatMap((m) => m.offers.map((o) => o.label)))];
    return [...ORDER.filter((p) => labels.includes(p)), ...labels.filter((p) => !ORDER.includes(p)).sort()];
  }
  function offerFor(market, plan) { return market.offers.find((offer) => offer.label === plan) || null; }
  function displayAmounts(market, offer) {
    if (!offer) return [];
    if (offer.label !== 'ChatGPT Plus' || offer.amounts.length !== 2) return offer.amounts;
    const pro20 = offerFor(market, 'ChatGPT Pro 20x');
    if (!pro20 || pro20.amounts.length !== 1) return offer.amounts;

    const sorted = [...offer.amounts].sort((a, b) => Number(a.amount) - Number(b.amount));
    const low = Number(sorted[0].amount);
    const high = Number(sorted[1].amount);
    const pro20Amount = Number(pro20.amounts[0].amount);
    if (![low, high, pro20Amount].every(Number.isFinite) || low <= 0 || high <= low) {
      return offer.amounts;
    }

    const plusGap = high - low;
    const distanceToPro20 = Math.abs(high - pro20Amount);
    return distanceToPro20 < plusGap ? [sorted[0]] : offer.amounts;
  }
  function minCny(market, plan) {
    const offer = offerFor(market, plan);
    if (!offer || !usable(market.last_verified_at)) return null;
    const values = offer.amounts
      .filter((amount) => amount.cny != null)
      .map((amount) => Number(amount.cny))
      .filter(Number.isFinite);
    return values.length ? Math.min(...values) : null;
  }
  function cnyText(market, amount) {
    if (!state.data.fx || !usable(state.data.fx.updated_at) || !usable(market.last_verified_at) || amount.cny == null) return '—';
    const value = Number(amount.cny);
    return Number.isFinite(value) ? `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
  }
  function formatCny(value) {
    return Number.isFinite(value) ? `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '暂无汇率';
  }

  function calculateMinimums() {
    state.minimums = new Map();
    const fxFresh = state.data.fx && usable(state.data.fx.updated_at) && age(state.data.fx.updated_at) <= FRESH;
    for (const plan of state.plans) {
      let value = Infinity;
      const markets = [];
      if (fxFresh) for (const market of state.data.markets) {
        if (!fresh(market)) continue;
        const candidate = minCny(market, plan);
        if (!Number.isFinite(candidate)) continue;
        if (candidate < value - .005) { value = candidate; markets.length = 0; markets.push(market); }
        else if (Math.abs(candidate - value) <= .005) markets.push(market);
      }
      markets.sort((a, b) => a.code.localeCompare(b.code));
      state.minimums.set(plan, { value: Number.isFinite(value) ? value : null, markets });
    }
  }

  function renderMinimums() {
    el.minimumSummary.style.setProperty('--plan-count', String(state.plans.length));
    const frag = document.createDocumentFragment();
    for (const plan of state.plans) {
      const info = state.minimums.get(plan) || { value: null, markets: [] };
      const card = document.createElement('button');
      card.type = 'button'; card.className = 'minimum-card';
      const label = Object.assign(document.createElement('span'), { className: 'minimum-plan-label', textContent: shortPlan(plan) });
      const country = document.createElement('strong'); country.className = 'minimum-country';
      const price = document.createElement('small'); price.className = 'minimum-price';
      if (!info.markets.length || !Number.isFinite(info.value)) {
        card.disabled = true; country.textContent = '暂无可靠最低价'; price.textContent = '—';
      } else {
        const names = info.markets.map((m) => m.name);
        country.textContent = names.length > 3 ? `${names.length} 个地区并列最低` : names.join('、');
        price.textContent = formatCny(info.value);
        card.dataset.plan = plan; card.dataset.marketId = info.markets[0].code;
        card.title = `查看 ${shortPlan(plan)} 全球最低价地区`;
        card.addEventListener('click', () => focusMinimum(plan, info.markets[0].code));
      }
      card.append(label, country, price); frag.append(card);
    }
    el.minimumSummary.replaceChildren(frag);
  }

  function renderStats() {
    const priced = state.data.markets.filter((m) => m.offers.length);
    el.marketCount.textContent = `${priced.length} / ${state.data.markets.length} 个地区`;
    el.currencyCount.textContent = `${new Set(priced.map((m) => m.currency).filter(Boolean)).size} 种`;
    el.planCount.textContent = `${state.plans.length} 档`;
  }

  function renderFreshness() {
    el.updatedAt.textContent = `更新于 ${dateTime(state.data.generated_at)}`;
    const stale = state.data.markets.filter((m) => m.offers.length && !fresh(m)).length;
    const fxStale = !state.data.fx || !usable(state.data.fx.updated_at) || age(state.data.fx.updated_at) > FRESH;
    const parts = [];
    if (!usable(state.data.generated_at)) parts.push('价格数据已过期');
    if (stale) parts.push(`${stale} 个地区为旧价或待复核`);
    if (fxStale) parts.push('汇率可能已旧');
    el.freshnessWarning.hidden = !parts.length; el.freshnessWarning.textContent = parts.join(' · ');
    el.fxStatus.textContent = state.data.fx ? `汇率更新：${dateTime(state.data.fx.updated_at)}${state.data.fx.fallback ? '（沿用）' : ''}` : '汇率暂不可用';
  }

  function calculateRanks() {
    state.ranks = new Map();
    const values = [...new Set(state.data.markets.map((m) => minCny(m, state.sortPlan)).filter(Number.isFinite).map((v) => v.toFixed(2)))]
      .map(Number).sort((a, b) => a - b);
    values.forEach((v, i) => state.ranks.set(v.toFixed(2), i + 1));
  }
  function rankFor(market) {
    const value = minCny(market, state.sortPlan);
    return Number.isFinite(value) ? state.ranks.get(value.toFixed(2)) ?? null : null;
  }

  function renderHeaders() {
    const row = document.querySelector('.price-table thead tr');
    row.querySelectorAll('[data-plan-header]').forEach((n) => n.remove());

    for (const plan of state.plans) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.dataset.planHeader = 'true';
      th.dataset.plan = plan;
      th.classList.toggle('is-active-plan', plan === state.activePlan);
      const active = state.sortKey === 'plan' && state.sortPlan === plan;
      th.setAttribute('aria-sort', active ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');

      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.sortPlan = plan;
      button.append(document.createTextNode(shortPlan(plan) + ' '));
      const icon = document.createElement('i');
      icon.dataset.lucide = active ? (state.sortDirection === 'asc' ? 'arrow-up' : 'arrow-down') : 'arrow-up-down';
      icon.setAttribute('aria-hidden', 'true');
      button.append(icon);
      button.addEventListener('click', () => setPlanSort(plan));
      th.append(button);
      row.append(th);
    }

    const country = row.querySelector('button[data-sort="country"]');
    const countryHeader = country?.closest('th');
    if (country && countryHeader) {
      country.disabled = false;
      const active = state.sortKey === 'country';
      countryHeader.setAttribute('aria-sort', active ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
      country.onclick = setCountrySort;
      replaceSortIcon(country, active);
    }

    updateRankingPresentation();
    refreshIcons();
  }

  function isMinimum(plan, market, amount) {
    const info = state.minimums.get(plan);
    return !!info && amount.cny != null && Number.isFinite(info.value) && info.markets.some((m) => m.code === market.code)
      && Number.isFinite(Number(amount.cny)) && Math.abs(Number(amount.cny) - info.value) <= .005;
  }

  function priceCell(market, plan) {
    const td = document.createElement('td'); td.className = 'price-cell'; td.dataset.plan = plan;
    td.classList.toggle('is-active-plan', plan === state.activePlan);
    td.classList.toggle('is-sorted', state.sortKey === 'plan' && state.sortPlan === plan);
    const offer = offerFor(market, plan);
    if (!offer) { td.classList.add('missing-price'); td.textContent = '—'; return td; }
    for (const amount of displayAmounts(market, offer)) {
      const option = document.createElement('div'); option.className = 'price-option';
      const cny = document.createElement('strong'); cny.className = 'price-cny';
      if (isMinimum(plan, market, amount)) {
        td.classList.add('is-minimum');
        const badge = document.createElement('span'); badge.className = 'minimum-badge'; badge.textContent = '最低'; cny.append(badge);
      }
      const rendered = cnyText(market, amount);
      if (rendered === '—') cny.append('—');
      else {
        const symbol = document.createElement('span'); symbol.className = 'price-symbol'; symbol.textContent = '¥';
        const number = document.createElement('span'); number.className = 'price-amount'; number.textContent = rendered.slice(1);
        cny.append(symbol, number);
      }
      const local = document.createElement('span'); local.className = 'price-local'; local.textContent = amount.display;
      option.append(cny, local); td.append(option);
    }
    return td;
  }

  function sortedMarkets() {
    const query = state.query.normalize('NFKC').trim().toLowerCase();
    const markets = state.data.markets.filter((m) => !query || `${m.name} ${m.code} ${m.currency || ''}`.normalize('NFKC').toLowerCase().includes(query));
    markets.sort((a, b) => {
      if (state.sortKey === 'country') {
        const cmp = a.name.localeCompare(b.name, 'zh-CN'); return state.sortDirection === 'asc' ? cmp : -cmp;
      }
      const av = minCny(a, state.sortPlan), bv = minCny(b, state.sortPlan);
      if (!Number.isFinite(av) && !Number.isFinite(bv)) return a.name.localeCompare(b.name, 'zh-CN');
      if (!Number.isFinite(av)) return 1; if (!Number.isFinite(bv)) return -1;
      const cmp = av - bv || a.name.localeCompare(b.name, 'zh-CN'); return state.sortDirection === 'asc' ? cmp : -cmp;
    });
    return markets;
  }

  function countryCell(market, displayedRank) {
    const td = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'country-history-button';

    const name = Object.assign(document.createElement('span'), {
      className: 'country-name',
      textContent: market.name,
    });
    const mobileRank = Object.assign(document.createElement('span'), {
      className: 'mobile-rank',
      textContent: state.sortKey === 'country' && displayedRank !== '—' && displayedRank != null
        ? `序${displayedRank}`
        : String(displayedRank ?? '—'),
    });
    mobileRank.setAttribute('aria-hidden', 'true');
    const mobileRankSr = Object.assign(document.createElement('span'), {
      className: 'mobile-rank-sr visually-hidden',
      textContent: mobileRankAccessibilityText(displayedRank),
    });
    const secondary = document.createElement('span');
    secondary.className = 'country-name-en';
    secondary.textContent = `${market.code.toUpperCase()} · ${market.currency || '—'}${market.status === 'verified' ? '' : ' · ' + STATUS[market.status]}`;
    const arrow = Object.assign(document.createElement('span'), {
      className: 'history-affordance',
      textContent: '›',
    });
    arrow.setAttribute('aria-hidden', 'true');
    const sr = Object.assign(document.createElement('span'), {
      className: 'visually-hidden',
      textContent: '，查看价格历史',
    });

    button.append(name, mobileRank, mobileRankSr, secondary, arrow, sr);
    button.addEventListener('click', () => openHistory(market, button));
    td.append(button);
    return td;
  }

  function renderTable() {
    calculateRanks();
    renderHeaders();
    const markets = sortedMarkets();
    const frag = document.createDocumentFragment();

    markets.forEach((market, index) => {
      const globalRank = rankFor(market);
      const displayedRank = state.sortKey === 'country' ? index + 1 : globalRank;
      const tr = document.createElement('tr');
      tr.dataset.marketId = market.code;

      const rankTd = document.createElement('td');
      rankTd.textContent = displayedRank ?? '—';
      if (state.sortKey === 'plan' && state.sortDirection === 'asc' && globalRank && globalRank <= 3) {
        rankTd.classList.add('rank-top');
      }

      tr.append(rankTd, countryCell(market, displayedRank));
      for (const plan of state.plans) tr.append(priceCell(market, plan));
      frag.append(tr);
    });

    el.priceRows.replaceChildren(frag);
    el.emptyState.hidden = markets.length !== 0;
    const suffix = state.sortKey === 'country'
      ? `按名称${state.sortDirection === 'asc' ? '排序' : '倒序'}`
      : `${shortPlan(state.sortPlan)} ${state.sortDirection === 'asc' ? '从低到高' : '从高到低'}`;
    el.resultSummary.textContent = `${state.query ? markets.length + ' / ' + state.data.markets.length : markets.length} 个地区 · ${suffix}`;
  }

  function planButtons(container, selected, handler) {
    container.replaceChildren(); container.style.setProperty('--plan-count', String(state.plans.length));
    for (const plan of state.plans) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = shortPlan(plan); b.setAttribute('aria-pressed', String(plan === selected));
      b.addEventListener('click', () => handler(plan)); container.append(b);
    }
  }
  function renderMobilePlans() {
    planButtons(el.mobilePlanControl, state.activePlan, (plan) => { state.activePlan = plan; state.sortKey = 'plan'; state.sortPlan = plan; state.sortDirection = 'asc'; renderMobilePlans(); renderTable(); });
  }
  function setCountrySort() { if (state.sortKey === 'country') state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc'; else { state.sortKey = 'country'; state.sortDirection = 'asc'; } renderTable(); }
  function setPlanSort(plan, force = false) {
    state.activePlan = plan;
    if (!force && state.sortKey === 'plan' && state.sortPlan === plan) state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = 'plan'; state.sortPlan = plan; state.sortDirection = 'asc'; }
    renderMobilePlans(); renderTable();
  }
  function focusMinimum(plan, marketId) {
    state.query = ''; el.searchInput.value = ''; setPlanSort(plan, true);
    const row = [...el.priceRows.querySelectorAll('tr[data-market-id]')].find((r) => r.dataset.marketId === marketId);
    if (!row) return;
    if (state.highlightTimer) clearTimeout(state.highlightTimer);
    row.classList.add('is-highlighted'); row.scrollIntoView({ block: 'center', inline: 'nearest' });
    row.querySelector('.country-history-button')?.focus({ preventScroll: true });
    state.highlightTimer = setTimeout(() => row.classList.remove('is-highlighted'), 1800);
  }

  function semantic(market) { return { currency: market.currency, offers: market.offers.map((o) => ({ label: o.label, amounts: o.amounts.map((a) => a.amount) })) }; }
  function snapshotOffer(snapshot, plan) { return snapshot.offers.find((o) => o.label === plan) || null; }
  function historyEvents(market) {
    const changes = state.data.changes.filter((c) => c.code === market.code).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const events = [];
    if (changes.length) { events.push({ at: changes[0].at, snapshot: changes[0].before }); for (const c of changes) events.push({ at: c.at, snapshot: c.after }); }
    const current = semantic(market);
    if (!events.length || canonical(events.at(-1).snapshot) !== canonical(current)) events.push({ at: state.data.generated_at, snapshot: current });
    return events;
  }
  function compactHistory(events, plan) {
    const out = []; let key = null;
    for (const event of events) {
      const offer = snapshotOffer(event.snapshot, plan), next = `${event.snapshot.currency}|${offer ? offer.amounts.join('/') : '--'}`;
      if (next === key) continue; out.push(event); key = next;
    }
    return out;
  }
  function renderHistoryPlans() { planButtons(el.historyPlanControl, state.historyPlan, (plan) => { state.historyPlan = plan; renderHistoryPlans(); renderHistory(); }); }
  function renderHistory() {
    const market = state.activeMarket; if (!market) return;
    const offer = offerFor(market, state.historyPlan);
    el.historyLocalPrice.textContent = offer ? offer.amounts.map((a) => a.display).join(' / ') : '—';
    el.historyCnyPrice.textContent = offer ? offer.amounts.map((a) => cnyText(market, a)).join(' / ') : '—';
    el.historyPlanHeader.textContent = shortPlan(state.historyPlan);
    const events = compactHistory(historyEvents(market), state.historyPlan); el.historyEventCount.textContent = `${Math.max(events.length - 1, 0)} 次`;
    el.historyRows.replaceChildren();
    for (const event of [...events].reverse()) {
      const tr = document.createElement('tr'), when = document.createElement('td'), currency = document.createElement('td'), price = document.createElement('td');
      when.textContent = dateTime(event.at); currency.textContent = event.snapshot.currency;
      const oldOffer = snapshotOffer(event.snapshot, state.historyPlan); price.textContent = oldOffer?.amounts?.length ? `${oldOffer.amounts.join(' / ')} ${event.snapshot.currency}` : '—';
      tr.append(when, currency, price); el.historyRows.append(tr);
    }
  }
  function openHistory(market, returnFocus) {
    state.activeMarket = market; state.historyReturnFocus = returnFocus; state.historyPlan = state.activePlan;
    el.historyTitle.textContent = market.name; el.historySubtitle.textContent = `${market.code.toUpperCase()} · ${market.currency || '—'} · 记录自本工具开始观察之日起`;
    renderHistoryPlans(); renderHistory(); el.historyDialog.showModal();
  }
  function closeHistory() { if (el.historyDialog.open) el.historyDialog.close(); }

  function backButton() {
    const rect = el.priceWorkspace.getBoundingClientRect(), visible = rect.top < -120 && rect.bottom > 120;
    el.backToTableButton.classList.toggle('is-visible', visible); el.backToTableButton.setAttribute('aria-hidden', String(!visible)); el.backToTableButton.tabIndex = visible ? 0 : -1;
  }
  function bind() {
    el.searchInput.addEventListener('input', () => { state.query = el.searchInput.value.normalize('NFKC').slice(0, 80); renderTable(); });
    el.closeHistory.addEventListener('click', closeHistory);
    el.historyDialog.addEventListener('close', () => { const target = state.historyReturnFocus; state.activeMarket = null; state.historyReturnFocus = null; target?.focus({ preventScroll: true }); });
    el.historyDialog.addEventListener('click', (event) => { if (event.target === el.historyDialog) closeHistory(); });
    el.backToTableButton.addEventListener('click', () => { el.priceWorkspace.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.priceWorkspace.focus({ preventScroll: true }); });
    addEventListener('scroll', () => { if (!state.scrollFrame) state.scrollFrame = requestAnimationFrame(() => { state.scrollFrame = null; backButton(); }); }, { passive: true });
    addEventListener('resize', backButton, { passive: true });
  }

  async function start() {
    const raw = JSON.parse($('price-data').textContent);
    validate(raw);
    await verifyRevision(raw);
    state.data = raw;
    state.plans = orderedPlans();
    const defaultPlan = state.plans.includes('ChatGPT Plus') ? 'ChatGPT Plus' : state.plans[0];
    state.activePlan = defaultPlan;
    state.sortPlan = defaultPlan;
    state.historyPlan = defaultPlan;
    el.searchInput.disabled = false;
    await loadIcons();
    calculateMinimums();
    renderMinimums();
    renderStats();
    renderFreshness();
    renderMobilePlans();
    bind();
    renderTable();
    backButton();
  }
  start().catch((error) => { console.error(error); el.freshnessWarning.hidden = false; el.freshnessWarning.textContent = '交互功能未能启动，当前仍显示静态价格'; });
})();
