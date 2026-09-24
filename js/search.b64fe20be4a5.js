(() => {
  'use strict';

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

  async function readSearchIndex(path) {
    const response = await fetch(path, { credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error(`Search index HTTP ${response.status}`);
    const xmlText = await response.text();
    const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('Search index XML is invalid');
    return [...xml.querySelectorAll('entry')].map((entry) => ({
      title: entry.querySelector('title')?.textContent?.trim() || 'Untitled',
      content: stripHtml(entry.querySelector('content')?.textContent || ''),
      url: entry.querySelector('link')?.getAttribute('href') || '#'
    }));
  }

  window.searchFunc = function searchFunc(path, searchId, contentId, options = {}) {
    const input = document.getElementById(searchId);
    const results = document.getElementById(contentId);
    const noResults = options.noResultsId ? document.getElementById(options.noResultsId) : null;
    if (!input || !results || input.dataset.searchReady === 'true') return;
    input.dataset.searchReady = 'true';

    let indexPromise = null;
    const ensureIndex = () => {
      if (!indexPromise) {
        results.setAttribute('aria-busy', 'true');
        const request = readSearchIndex(path);
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

    const render = async (version) => {
      if (version !== queryVersion) return;
      const query = input.value.trim().toLocaleLowerCase();
      if (!query) return;

      try {
        const data = await ensureIndex();
        if (version !== queryVersion) return;
        const words = query.split(/\s+/).filter(Boolean);
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
