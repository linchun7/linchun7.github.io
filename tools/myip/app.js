(() => {
    'use strict';

    const REQUEST_TIMEOUT_MS = 4500;
    const IPV6_TIMEOUT_MS = 2800;

    const routeResults = {
        domestic: { status: 'idle', observations: [], detail: '' },
        international: { status: 'idle', observations: [], detail: '' }
    };

    let activeRunId = 0;
    const $ = (id) => document.getElementById(id);

    function normalizeText(value) {
        if (value === null || value === undefined) return '';
        return String(value).trim();
    }

    function joinText(values) {
        return values.map(normalizeText).filter(Boolean).join(' · ');
    }

    function parseIpv4(value) {
        const text = normalizeText(value);
        const match = text.match(/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/);
        if (!match) return null;
        return text.split('.').map(Number);
    }

    function isIpv6Address(value) {
        const text = normalizeText(value).split('%')[0];
        if (!text || !text.includes(':') || text.length > 45) return false;
        try {
            new URL(`http://[${text}]/`);
            return true;
        } catch {
            return false;
        }
    }

    function isPublicIpv4(value) {
        const parts = parseIpv4(value);
        if (!parts) return false;
        const [a, b, c] = parts;

        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 192 && b === 0 && c === 0) return false;
        if (a === 192 && b === 0 && c === 2) return false;
        if (a === 198 && (b === 18 || b === 19)) return false;
        if (a === 198 && b === 51 && c === 100) return false;
        if (a === 203 && b === 0 && c === 113) return false;
        return true;
    }

    function isPublicIpv6(value) {
        const text = normalizeText(value).split('%')[0].toLowerCase();
        if (!isIpv6Address(text)) return false;
        if (text === '::' || text === '::1') return false;
        if (text.startsWith('fc') || text.startsWith('fd')) return false;
        if (/^fe[89ab]/.test(text)) return false;
        if (text.startsWith('ff')) return false;
        if (text.startsWith('2001:db8')) return false;
        if (text.startsWith('::ffff:')) return false;
        return true;
    }

    function ipFamily(value) {
        if (parseIpv4(value)) return 4;
        if (isIpv6Address(value)) return 6;
        return null;
    }

    function isPublicIpAddress(value) {
        const family = ipFamily(value);
        if (family === 4) return isPublicIpv4(value);
        if (family === 6) return isPublicIpv6(value);
        return false;
    }

    class HttpError extends Error {
        constructor(status) {
            super(`HTTP ${status}`);
            this.name = 'HttpError';
            this.status = status;
        }
    }

    function createTimeoutError() {
        const error = new Error('请求超时');
        error.name = 'TimeoutError';
        return error;
    }

    async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = window.setTimeout(() => {
                if (controller) controller.abort();
                reject(createTimeoutError());
            }, timeoutMs);
        });

        try {
            const response = await Promise.race([
                fetch(url, {
                    cache: 'no-store',
                    credentials: 'omit',
                    ...options,
                    ...(controller ? { signal: controller.signal } : {})
                }),
                timeoutPromise
            ]);
            if (!response.ok) throw new HttpError(response.status);
            return response;
        } catch (error) {
            if (error && error.name === 'AbortError') throw createTimeoutError();
            throw error;
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    async function fetchJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            mode: 'cors',
            headers: { Accept: 'application/json' }
        }, timeoutMs);
        return response.json();
    }

    async function fetchText(url, timeoutMs = REQUEST_TIMEOUT_MS) {
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            mode: 'cors',
            headers: { Accept: 'text/plain' }
        }, timeoutMs);
        return response.text();
    }

    function formatError(error) {
        if (!error) return '未响应';
        if (error.name === 'TimeoutError') return '连接超时';
        if (error.name === 'HttpError') return `HTTP ${error.status}`;
        if (error instanceof TypeError) return '网络请求被阻止';
        return normalizeText(error.message) || '未响应';
    }

    function setText(id, value) {
        const element = $(id);
        if (element) element.textContent = normalizeText(value);
    }

    function setStatus(id, state, text) {
        const element = $(id);
        if (!element) return;
        element.className = `status-pill status-${state}`;
        element.textContent = text;
    }

    function setSource(id, state, statusText, detail) {
        setStatus(`source-${id}-status`, state, statusText);
        setText(`source-${id}-detail`, detail);
    }

    function getFirstPartyProbeUrl() {
        const meta = document.querySelector('meta[name="myip-first-party-probe"]');
        const raw = normalizeText(meta && meta.getAttribute('content'));
        if (!raw) return '';
        try {
            const url = new URL(raw);
            return url.protocol === 'https:' ? url.href : '';
        } catch {
            return '';
        }
    }

    function makeObservation(ip, source, detail = '', role = 'verification') {
        const normalized = normalizeText(ip);
        if (!isPublicIpAddress(normalized)) throw new Error(`${source} 返回了非公网 IP，已忽略`);
        return {
            ip: normalized,
            family: ipFamily(normalized),
            source,
            detail: normalizeText(detail),
            role
        };
    }

    function preferredObservation(route, family) {
        return (routeResults[route].observations || []).find((item) => item.family === family) || null;
    }

    function routeIsFinal(route) {
        return routeResults[route].status === 'success' || routeResults[route].status === 'error';
    }

    function displayIp(route, family) {
        const observation = preferredObservation(route, family);
        if (observation) return observation.ip;
        return routeIsFinal(route) ? '未检测到' : '检测中…';
    }

    function routeHasDisagreement(route, family) {
        const ips = (routeResults[route].observations || [])
            .filter((item) => item.family === family)
            .map((item) => item.ip);
        return new Set(ips).size > 1;
    }

    function renderRoute(route) {
        const current = routeResults[route];
        setText(`${route}-ipv4`, displayIp(route, 4));
        if (route === 'international') setText(`${route}-ipv6`, displayIp(route, 6));
        setText(`${route}-detail`, current.detail || (route === 'domestic'
            ? '通过国内 IP 查询网站检测。'
            : '通过本站检测服务和多个独立 IP 服务交叉确认。'));

        if (current.status === 'loading' || current.status === 'idle') {
            setStatus(`${route}-status`, 'loading', '检测中');
        } else if (current.status === 'error') {
            setStatus(`${route}-status`, 'warning', '未获取');
        } else {
            setStatus(`${route}-status`, 'success', '已获取');
        }
        renderSummary();
    }

    function compareFamily(family) {
        const domestic = preferredObservation('domestic', family);
        const international = preferredObservation('international', family);
        if (!domestic || !international) return null;
        return {
            family,
            same: domestic.ip === international.ip,
            domestic,
            international
        };
    }

    function firstRouteIp(route) {
        return preferredObservation(route, 4)?.ip || preferredObservation(route, 6)?.ip || '';
    }

    function renderSummary() {
        const domesticFinal = routeIsFinal('domestic');
        const internationalFinal = routeIsFinal('international');
        const domesticOk = routeResults.domestic.status === 'success';
        const internationalOk = routeResults.international.status === 'success';

        if (!domesticFinal || !internationalFinal) {
            setStatus('summary-status', 'loading', '检测中');
            setText('summary-main', '正在检测国内和国际网站的访问 IP…');
            setText('summary-detail', '检测结果会陆续返回，请稍候。');
            return;
        }

        if (!domesticOk && !internationalOk) {
            setStatus('summary-status', 'error', '未获取');
            setText('summary-main', '暂时没能获取公网 IP');
            setText('summary-detail', '可以重新检测；代理规则、浏览器插件或当前网络都可能影响第三方检测请求。');
            return;
        }

        if (!domesticOk || !internationalOk) {
            setStatus('summary-status', 'warning', '部分结果');
            setText('summary-main', domesticOk ? '已获取国内网站 IP' : '已获取国际网站 IP');
            setText('summary-detail', domesticOk
                ? '国际网站 IP 暂未获取，因此现在还不能判断是否存在国内外分流。'
                : '国内网站 IP 暂未获取，因此现在还不能判断是否存在国内外分流。');
            return;
        }

        const comparisons = [compareFamily(4), compareFamily(6)].filter(Boolean);
        const split = comparisons.find((item) => !item.same);
        const same = comparisons.find((item) => item.same);
        const domesticIp = firstRouteIp('domestic');
        const internationalIp = firstRouteIp('international');

        if (split) {
            setStatus('summary-status', 'warning', '已分流');
            setText('summary-main', '国内和国际网站使用不同 IP');
            setText('summary-detail', `访问国内网站：${domesticIp}；访问国际网站：${internationalIp}。这通常表示代理或分流规则正在使用不同出口。`);
            return;
        }

        if (same) {
            setStatus('summary-status', 'success', '同一出口');
            setText('summary-main', '国内和国际网站使用同一个 IP');
            setText('summary-detail', `当前共同出口：${same.domestic.ip}。如果你开启了代理，可能是全局代理或这些检测域名被分到了同一路径。`);
            return;
        }

        setStatus('summary-status', 'success', '已获取');
        setText('summary-main', '国内和国际网站 IP 已获取');
        setText('summary-detail', '两边当前没有可直接比较的同一种 IP 类型，因此不据此判断是否分流。');
    }

    function resetRoutes() {
        routeResults.domestic = { status: 'loading', observations: [], detail: '' };
        routeResults.international = { status: 'loading', observations: [], detail: '' };
        renderRoute('domestic');
        renderRoute('international');
    }

    function resetSources() {
        setSource('pconline', 'loading', '检测中', '太平洋网络');
        setSource('ipw', 'loading', '检测中', 'IPW');
        setSource('firstparty', 'loading', '检测中', 'Cloudflare Worker');
        setSource('ipsb', 'loading', '检测中', '国际 IP 复核');
        setSource('ipify4', 'loading', '检测中', 'IPv4 复核');
        setSource('ipify6', 'loading', '检测中', 'IPv6 复核');
        setSource('backup', 'loading', '检测中', 'IPWho.is 备用检测');
    }

    function escapeHtmlAttribute(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('"', '&quot;')
            .replaceAll('<', '&lt;');
    }

    function runSandboxedScriptProbe({ timeoutMs = REQUEST_TIMEOUT_MS, buildSrcdoc }) {
        return new Promise((resolve, reject) => {
            const token = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const iframe = document.createElement('iframe');
            let settled = false;

            iframe.hidden = true;
            iframe.tabIndex = -1;
            iframe.setAttribute('aria-hidden', 'true');
            iframe.setAttribute('sandbox', 'allow-scripts');
            iframe.referrerPolicy = 'no-referrer';

            const cleanup = () => {
                window.clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                iframe.remove();
            };
            const finish = (handler, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                handler(value);
            };
            const onMessage = (event) => {
                if (event.source !== iframe.contentWindow) return;
                const data = event.data;
                if (!data || data.__myipProbe !== token) return;
                if (data.ok) finish(resolve, data.payload);
                else finish(reject, new Error(normalizeText(data.error) || '加载失败'));
            };

            const timer = window.setTimeout(() => finish(reject, createTimeoutError()), timeoutMs);
            window.addEventListener('message', onMessage);
            iframe.srcdoc = buildSrcdoc(token);
            document.body.appendChild(iframe);
        });
    }

    async function loadPconline() {
        const src = `https://whois.pconline.com.cn/ipJson.jsp?json=true&callback=__myipProbeCallback&_=${Date.now()}`;
        const payload = await runSandboxedScriptProbe({
            buildSrcdoc(token) {
                const tokenLiteral = JSON.stringify(token);
                return `<!doctype html><meta charset="utf-8"><script>
                    const __token = ${tokenLiteral};
                    const __send = (ok, payload, error) => parent.postMessage({ __myipProbe: __token, ok, payload, error }, '*');
                    window.__myipProbeCallback = (payload) => __send(true, payload, '');
                    window.__myipProbeFail = () => __send(false, null, '加载失败');
                </script><script src="${escapeHtmlAttribute(src)}" referrerpolicy="no-referrer" onerror="window.__myipProbeFail()"></script>`;
            }
        });
        const ip = normalizeText(payload && payload.ip);
        const detail = joinText([
            payload && (payload.country || payload.nation),
            payload && payload.pro,
            payload && payload.city,
            payload && payload.region,
            payload && payload.addr && payload.addr !== ip ? payload.addr : '',
            payload && payload.isp
        ]);
        return makeObservation(ip, '太平洋网络', detail, 'domestic-primary');
    }

    async function loadIpw() {
        const text = normalizeText(await fetchText('https://4.ipw.cn/'));
        const ip = text.split(/\s+/)[0];
        return makeObservation(ip, 'IPW', '', 'domestic-backup');
    }

    async function loadDomestic(runId) {
        const pconlineTask = (async () => {
            try {
                const observation = await loadPconline();
                if (runId !== activeRunId) return null;
                setSource('pconline', 'success', '正常', observation.detail || observation.ip);
                return observation;
            } catch (error) {
                if (runId !== activeRunId) return null;
                const invalid = /非公网 IP/.test(formatError(error));
                setSource('pconline', 'warning', invalid ? '已忽略' : '未响应', formatError(error));
                return null;
            }
        })();

        const ipwTask = (async () => {
            try {
                const observation = await loadIpw();
                if (runId !== activeRunId) return null;
                setSource('ipw', 'success', '备用正常', observation.ip);
                return observation;
            } catch (error) {
                if (runId !== activeRunId) return null;
                const invalid = /非公网 IP/.test(formatError(error));
                setSource('ipw', 'warning', invalid ? '备用已忽略' : '备用未响应', formatError(error));
                return null;
            }
        })();

        const [pconline, ipw] = await Promise.all([pconlineTask, ipwTask]);
        if (runId !== activeRunId) return;
        const observations = [pconline, ipw].filter(Boolean);

        if (observations.length) {
            const preferred = observations[0];
            const disagreement = observations.length > 1 && observations[0].ip !== observations[1].ip;
            routeResults.domestic = {
                status: 'success',
                observations,
                detail: `访问国内检测网站时使用 ${preferred.ip}。${disagreement ? '备用检测返回了另一个 IP，可在检测详情中查看。' : ''}`
            };
        } else {
            routeResults.domestic = {
                status: 'error',
                observations: [],
                detail: '国内网站 IP 暂未获取。'
            };
        }
        renderRoute('domestic');
    }

    function firstPartyDetail(data) {
        const network = data && data.network ? data.network : {};
        return joinText([
            network.country,
            network.region,
            network.city,
            network.asn ? `AS${network.asn}` : '',
            network.organization
        ]);
    }

    async function internationalTask(runId, id, successLabel, loader) {
        try {
            const result = await loader();
            if (runId !== activeRunId) return [];
            const observations = Array.isArray(result) ? result : [result];
            const valid = observations.filter(Boolean);
            if (!valid.length) throw new Error('未返回公网 IP');
            const detail = valid.map((item) => item.detail || item.ip).filter(Boolean).join(' · ');
            setSource(id, 'success', successLabel, detail);
            return valid;
        } catch (error) {
            if (runId !== activeRunId) return [];
            const isIpv6 = id === 'ipify6';
            const isBackup = id === 'backup';
            setSource(
                id,
                isIpv6 ? 'idle' : 'warning',
                isIpv6 ? '未检测到' : (isBackup ? '备用未响应' : '未响应'),
                formatError(error)
            );
            return [];
        }
    }

    async function loadInternational(runId) {
        const firstPartyUrl = getFirstPartyProbeUrl();
        const tasks = [
            internationalTask(runId, 'firstparty', '正常', async () => {
                if (!firstPartyUrl) throw new Error('本站检测地址未配置');
                const data = await fetchJson(firstPartyUrl);
                if (!data || data.schemaVersion !== 1 || data.role !== 'international-first-party') throw new Error('返回格式不正确');
                const detail = firstPartyDetail(data);
                const observations = [makeObservation(data.ip, '本站国际检测', detail, 'international-primary')];
                if (data.originalIpv6 && normalizeText(data.originalIpv6) !== normalizeText(data.ip)) {
                    observations.push(makeObservation(data.originalIpv6, '本站国际检测 IPv6', detail, 'international-primary'));
                }
                return observations;
            }),
            internationalTask(runId, 'ipsb', '正常', async () => {
                const data = await fetchJson('https://api.ip.sb/geoip');
                const detail = joinText([data && data.country, data && data.region, data && data.city, data && (data.isp || data.organization || data.asn_organization)]);
                return makeObservation(data && data.ip, 'IP.SB', detail);
            }),
            internationalTask(runId, 'ipify4', '正常', async () => {
                const data = await fetchJson('https://api.ipify.org?format=json');
                if (!data || ipFamily(data.ip) !== 4) throw new Error('未返回 IPv4');
                return makeObservation(data.ip, 'IPify IPv4');
            }),
            internationalTask(runId, 'ipify6', '正常', async () => {
                const data = await fetchJson('https://api6.ipify.org?format=json', IPV6_TIMEOUT_MS);
                if (!data || ipFamily(data.ip) !== 6) throw new Error('未返回 IPv6');
                return makeObservation(data.ip, 'IPify IPv6');
            }),
            internationalTask(runId, 'backup', '备用正常', async () => {
                const data = await fetchJson('https://ipwho.is/');
                if (!data || data.success === false) throw new Error('备用服务未返回结果');
                const detail = joinText([
                    data.country,
                    data.region,
                    data.city,
                    data.connection && (data.connection.isp || data.connection.org)
                ]);
                return makeObservation(data.ip, 'IPWho.is', detail, 'international-backup');
            })
        ];

        const groups = await Promise.all(tasks);
        if (runId !== activeRunId) return;
        const observations = groups.flat();

        if (observations.length) {
            const preferredV4 = observations.find((item) => item.family === 4);
            const preferredV6 = observations.find((item) => item.family === 6);
            const preferred = preferredV4 || preferredV6;
            const disagreement = routeHasDisagreementFrom(observations, 4) || routeHasDisagreementFrom(observations, 6);
            routeResults.international = {
                status: 'success',
                observations,
                detail: `${preferred?.detail ? `${preferred.detail}。` : ''}访问国际检测网站时使用 ${preferred?.ip || '已获取的公网 IP'}。${disagreement ? '部分备用检测返回了不同 IP，可在检测详情中查看。' : ''}`
            };
        } else {
            routeResults.international = {
                status: 'error',
                observations: [],
                detail: '国际网站 IP 暂未获取。'
            };
        }
        renderRoute('international');
    }

    function routeHasDisagreementFrom(observations, family) {
        const ips = observations.filter((item) => item.family === family).map((item) => item.ip);
        return new Set(ips).size > 1;
    }

    function runAll() {
        activeRunId += 1;
        const runId = activeRunId;
        resetRoutes();
        resetSources();
        loadDomestic(runId);
        loadInternational(runId);
    }

    function init() {
        const retryButton = $('retry-all');
        if (retryButton) retryButton.addEventListener('click', runAll);
        runAll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
