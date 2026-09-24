(() => {
  'use strict';

  const MAX_QUERY_CHARS = 200;
  const MAX_QUERY_TERMS = 20;
  const DEFAULT_INDEX_TIMEOUT_MS = 10000;

  function stripHtml(html) {
    const documentFragment = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    documentFragment.querySelectorAll('style,script,figure').forEach((node) => node.remove());
    return (documentFragment.body.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function combinations(words) {
    const result = [];
    for (let start = 0; start < words.length; start += 1) {
      for (let end = start + 1; end <= words.length; end += 1) {
        result.push(words.slice(start, end).join(' '));
      }
    }
    return result.sort((a, b) => b.split(' ').length - a.split(' ').length);
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function appendHighlightedText(parent, text, keywords) {
    const safeKeywords = keywords.filter(Boolean).map(escapeRegExp);
    if (!safeKeywords.length) {
      parent.append(document.createTextNode(text));
      return;
    }
    const matcher = new RegExp(`(${safeKeywords.join('|')})`, 'gi');
    let cursor = 0;
    for (const match of text.matchAll(matcher)) {
      if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
      const emphasis = document.createElement('em');
      emphasis.className = 'search-keyword';
      emphasis.textContent = match[0];
      parent.append(emphasis);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }

  function snippet(content, firstOccurrence) {
    const start = Math.max(0, firstOccurrence - 24);
    const end = Math.min(content.length, start === 0 ? 120 : firstOccurrence + 96);
    return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
  }

  async function readSearchIndex(path, timeoutMs = DEFAULT_INDEX_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { credentials: 'same-origin', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error(`Search index HTTP ${response.status}`);
      const xmlText = await response.text();
      const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
      if (xml.querySelector('parsererror')) throw new Error('Search index XML is invalid');
      const root = xml.documentElement;
      if (!root || root.localName !== 'search') throw new Error('Search index root is invalid');
      const entries = [...root.children].filter((node) => node.localName === 'entry');
      if (!entries.length) throw new Error('Search index has no entries');
      return entries.map((entry) => {
        const child = (name) => [...entry.children].find((node) => node.localName === name) || null;
        const title = child('title')?.textContent?.trim() || '';
        const contentNode = child('content');
        const link = child('link')?.getAttribute('href')?.trim() || '';
        if (!title || !contentNode || !link) throw new Error('Search index entry is invalid');
        return {
          title,
          content: stripHtml(contentNode.textContent || ''),
          url: link
        };
      });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  window.searchFunc = function searchFunc(path, searchId, contentId, options = {}) {
    const input = document.getElementById(searchId);
    const results = document.getElementById(contentId);
    const noResults = options.noResultsId ? document.getElementById(options.noResultsId) : null;
    if (!input || !results || input.dataset.searchReady === 'true') return;
    input.dataset.searchReady = 'true';
    const requestedTimeoutMs = Number(options.indexTimeoutMs);
    const indexTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs >= 100 && requestedTimeoutMs <= 30000
      ? requestedTimeoutMs
      : DEFAULT_INDEX_TIMEOUT_MS;

    let indexPromise = null;
    const ensureIndex = () => {
      if (!indexPromise) {
        results.setAttribute('aria-busy', 'true');
        const request = readSearchIndex(path, indexTimeoutMs);
        indexPromise = request;
        request.then(
          () => {
            if (indexPromise === request) results.setAttribute('aria-busy', 'false');
          },
          () => {
            if (indexPromise === request) {
              indexPromise = null;
              results.setAttribute('aria-busy', 'false');
            }
          }
        );
      }
      return indexPromise;
    };

    let queryVersion = 0;
    let timer = null;

    const clearRenderedState = () => {
      results.replaceChildren();
      if (noResults) noResults.hidden = true;
    };

    const queryParts = (value) => value.trim().split(/\s+/).filter(Boolean);
    const isQueryTooLong = (value) => value.length > MAX_QUERY_CHARS || queryParts(value).length > MAX_QUERY_TERMS;
    const renderTooLong = () => {
      clearRenderedState();
      const message = document.createElement('p');
      message.className = 'search-error search-too-long';
      message.textContent = options.tooLongText || 'Search query is too long. Please shorten it.';
      results.append(message);
    };

    const render = async (version) => {
      if (version !== queryVersion) return;
      const query = input.value.trim().toLocaleLowerCase();
      if (!query) return;
      if (isQueryTooLong(query)) {
        renderTooLong();
        return;
      }

      try {
        const data = await ensureIndex();
        if (version !== queryVersion) return;
        const words = queryParts(query);
        const keywords = combinations(words);
        const ranked = [];

        for (const item of data) {
          const title = item.title.toLocaleLowerCase();
          const content = item.content.toLocaleLowerCase();
          let rank = 0;
          let firstOccurrence = -1;
          for (const keyword of keywords) {
            const titleIndex = title.indexOf(keyword);
            const contentIndex = content.indexOf(keyword);
            if (titleIndex >= 0 || contentIndex >= 0) {
              rank += titleIndex >= 0 ? 2 : 1;
              if (contentIndex >= 0 && (firstOccurrence < 0 || contentIndex < firstOccurrence)) firstOccurrence = contentIndex;
            }
          }
          if (rank > 0) ranked.push({ ...item, rank, firstOccurrence });
        }

        ranked.sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title, 'zh-CN'));
        const list = document.createElement('ul');
        list.className = 'search-result-list';

        for (const item of ranked.slice(0, 100)) {
          const li = document.createElement('li');
          const link = document.createElement('a');
          link.className = 'search-result-title';
          link.href = item.url;
          link.textContent = item.title;
          li.append(link);

          if (item.firstOccurrence >= 0) {
            const paragraph = document.createElement('p');
            paragraph.className = 'search-result';
            appendHighlightedText(paragraph, snippet(item.content, item.firstOccurrence), keywords);
            li.append(paragraph);
          }
          list.append(li);
        }

        if (version !== queryVersion) return;
        clearRenderedState();
        if (ranked.length) results.append(list);
        else if (noResults) noResults.hidden = false;
      } catch (error) {
        if (version !== queryVersion) return;
        console.warn('Search index load failed:', error);
        clearRenderedState();
        const message = document.createElement('p');
        message.className = 'search-error';
        message.textContent = options.errorText || 'Search is temporarily unavailable.';
        results.append(message);
      }
    };

    const scheduleRender = ({ immediate = false } = {}) => {
      queryVersion += 1;
      const version = queryVersion;
      window.clearTimeout(timer);
      timer = null;
      clearRenderedState();
      if (!input.value.trim()) return;
      if (isQueryTooLong(input.value.trim())) {
        renderTooLong();
        return;
      }
      if (immediate) {
        void render(version);
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        void render(version);
      }, 80);
    };

    input.addEventListener('input', () => scheduleRender());
    input.addEventListener('focus', () => { void ensureIndex().catch(() => {}); }, { once: true });
    input.closest('form')?.addEventListener('submit', (event) => event.preventDefault());
    if (input.value.trim()) scheduleRender({ immediate: true });
  };
})();
