(() => {
    'use strict';

    const REQUEST_TIMEOUT_MS = 4500;
    const IPV6_TIMEOUT_MS = 2800;
    const LOCAL_REFERENCE_TIMEOUT_MS = 2800;

    const routeResults = {
        domestic: { status: 'idle', observations: [], detail: '' },
        international: { status: 'idle', observations: [], detail: '' }
    };

    const localReference = {
        status: 'idle',
        observation: null
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

    function joinUniqueText(values) {
        const seen = new Set();
        const result = [];
        for (const value of values.map(normalizeText).filter(Boolean)) {
            const key = value.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(value);
        }
        return result.join(' · ');
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

    function preferredAnyObservation(route) {
        return preferredObservation(route, 4) || preferredObservation(route, 6) || null;
    }

    function routeIsFinal(route) {
        return ['success', 'reference', 'error'].includes(routeResults[route].status);
    }

    function displayIp(route, family) {
        const observation = preferredObservation(route, family);
        if (observation) return observation.ip;
        return routeIsFinal(route) ? '未检测到' : '检测中…';
    }

    function renderRoute(route) {
        const current = routeResults[route];

        if (route === 'domestic') {
            const observation = preferredAnyObservation('domestic');
            setText('domestic-ipv4', observation ? observation.ip : (routeIsFinal('domestic') ? '未检测到' : '检测中…'));
            setText('domestic-ip-label', observation
                ? `${current.status === 'reference' ? '参考 ' : ''}IPv${observation.family}`
                : 'IPv4');
        } else {
            setText('international-ipv4', displayIp('international', 4));
            setText('international-ipv6', displayIp('international', 6));
        }

        setText(`${route}-detail`, current.detail || '正在获取地区和运营商信息…');

        if (current.status === 'loading' || current.status === 'idle') {
            setStatus(`${route}-status`, 'loading', '检测中');
        } else if (current.status === 'error') {
            setStatus(`${route}-status`, 'warning', '未获取');
        } else if (current.status === 'reference') {
            setStatus(`${route}-status`, 'warning', '参考');
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

    function renderSummary() {
        const domesticFinal = routeIsFinal('domestic');
        const internationalFinal = routeIsFinal('international');
        const domesticOk = routeResults.domestic.status === 'success';
        const domesticReference = routeResults.domestic.status === 'reference';
        const internationalOk = routeResults.international.status === 'success';

        if (!domesticFinal || !internationalFinal) {
            setStatus('summary-status', 'loading', '检测中');
            setText('summary-main', '正在检测网络出口…');
            setText('summary-detail', '请稍候，国内和国际检测结果会分别返回。');
            return;
        }

        if (domesticOk && internationalOk) {
            const comparisons = [compareFamily(4), compareFamily(6)].filter(Boolean);
            const split = comparisons.some((item) => !item.same);
            const same = comparisons.some((item) => item.same);

            if (split) {
                setStatus('summary-status', 'warning', '已分流');
                setText('summary-main', '国内外访问使用不同出口');
                setText('summary-detail', '这通常表示代理或规则分流正在生效。');
                return;
            }

            if (same) {
                setStatus('summary-status', 'success', '同一出口');
                setText('summary-main', '国内外访问使用同一出口');
                setText('summary-detail', '可能是直连、全局代理，或两个检测域名被分到了同一路径。');
                return;
            }

            setStatus('summary-status', 'success', '已获取');
            setText('summary-main', '国内外 IP 均已获取');
            setText('summary-detail', '两边当前没有可直接比较的同一种 IP 类型，因此不判断是否分流。');
            return;
        }

        if (domesticReference && internationalOk) {
            setStatus('summary-status', 'warning', '部分结果');
            setText('summary-main', '国际出口已确认，国内路径待确认');
            setText('summary-detail', '国内卡片显示参考值，不参与分流判断。');
            return;
        }

        if (domesticOk && !internationalOk) {
            setStatus('summary-status', 'warning', '部分结果');
            setText('summary-main', '国内出口已确认，国际路径待确认');
            setText('summary-detail', '可以稍后重新检测国际出口。');
            return;
        }

        if (!domesticOk && internationalOk) {
            setStatus('summary-status', 'warning', '部分结果');
            setText('summary-main', '国际出口已确认，国内路径待确认');
            setText('summary-detail', '可以稍后重新检测国内出口。');
            return;
        }

        setStatus('summary-status', 'error', '未获取');
        setText('summary-main', '暂未确认网络出口');
        setText('summary-detail', '代理规则、浏览器插件或当前网络都可能影响检测请求。');
    }

    function resetRoutes() {
        routeResults.domestic = { status: 'loading', observations: [], detail: '' };
        routeResults.international = { status: 'loading', observations: [], detail: '' };
        localReference.status = 'loading';
        localReference.observation = null;
        renderRoute('domestic');
        renderRoute('international');
    }

    function resetSources() {
        setSource('pconline', 'loading', '检测中', 'whois.pconline.com.cn · 检测访问国内站点时看到的公网 IP');
        setSource('ipw', 'loading', '检测中', '4.ipw.cn · 国内路径备用检测');
        setSource('localref', 'loading', '检测中', 'STUN：stun.cloudflare.com / stun.l.google.com · 仅供参考，不参与分流判断');
        setSource('firstparty', 'loading', '检测中', 'myip.cfw3.workers.dev · 国际主结果');
        setSource('ipsb', 'loading', '检测中', 'api.ip.sb · 国际出口复核');
        setSource('ipify4', 'loading', '检测中', 'api.ipify.org · IPv4 复核');
        setSource('ipify6', 'loading', '检测中', 'api6.ipify.org · IPv6 复核');
        setSource('backup', 'loading', '检测中', 'ipwho.is · 国际备用检测');
    }

    function loadJsonp(baseUrl, timeoutMs = REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const callbackName = `__myipJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const script = document.createElement('script');
            let settled = false;

            const cleanup = () => {
                window.clearTimeout(timer);
                script.remove();
                try {
                    delete window[callbackName];
                } catch {
                    window[callbackName] = undefined;
                }
            };

            const finish = (handler, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                handler(value);
            };

            window[callbackName] = (payload) => finish(resolve, payload);
            script.async = true;
            script.referrerPolicy = 'no-referrer';
            script.onerror = () => finish(reject, new Error('加载失败'));

            const url = new URL(baseUrl);
            url.searchParams.set('callback', callbackName);
            url.searchParams.set('_', String(Date.now()));
            script.src = url.href;

            const timer = window.setTimeout(() => finish(reject, createTimeoutError()), timeoutMs);
            document.head.appendChild(script);
        });
    }

    function domesticLocationDetail(payload, ip) {
        const province = normalizeText(payload && payload.pro);
        const city = normalizeText(payload && payload.city);
        const region = normalizeText(payload && payload.region);
        let operator = normalizeText(payload && payload.isp);
        let address = normalizeText(payload && payload.addr);

        if (address && address !== ip) {
            for (const prefix of [province, city, region].filter(Boolean)) {
                address = address.replace(prefix, '').trim();
            }
        }
        if (!operator) operator = address;

        return joinUniqueText([
            payload && (payload.country || payload.nation),
            province,
            city,
            region,
            operator
        ]);
    }

    async function loadPconline() {
        const payload = await loadJsonp('https://whois.pconline.com.cn/ipJson.jsp');
        const ip = normalizeText(payload && payload.ip);
        const detail = domesticLocationDetail(payload, ip);
        return makeObservation(ip, '太平洋网络', detail, 'domestic-primary');
    }

    async function loadIpw() {
        const text = normalizeText(await fetchText('https://4.ipw.cn/'));
        const ip = text.split(/\s+/)[0];
        return makeObservation(ip, 'IPW', '', 'domestic-backup');
    }

    function getCandidateAddress(candidate) {
        if (!candidate) return '';
        if (candidate.address) return normalizeText(candidate.address);
        const raw = normalizeText(candidate.candidate);
        const parts = raw.split(/\s+/);
        return parts.length >= 6 ? normalizeText(parts[4]) : '';
    }

    async function loadBrowserNetworkReference() {
        const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (typeof PeerConnection !== 'function') return null;

        let pc;
        const found = [];

        try {
            pc = new PeerConnection({
                iceServers: [
                    { urls: 'stun:stun.cloudflare.com:3478' },
                    { urls: 'stun:stun.l.google.com:19302' }
                ]
            });
            pc.createDataChannel('ip-reference');

            await new Promise(async (resolve) => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timer);
                    resolve();
                };
                const timer = window.setTimeout(finish, LOCAL_REFERENCE_TIMEOUT_MS);

                pc.onicecandidate = (event) => {
                    if (!event.candidate) {
                        finish();
                        return;
                    }
                    const type = normalizeText(event.candidate.type);
                    if (type !== 'srflx' && type !== 'relay') return;
                    const address = getCandidateAddress(event.candidate);
                    if (isPublicIpAddress(address) && !found.includes(address)) found.push(address);
                };
                pc.onicecandidateerror = () => {};

                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                } catch {
                    finish();
                }
            });
        } finally {
            if (pc) {
                pc.onicecandidate = null;
                pc.onicecandidateerror = null;
                pc.close();
            }
        }

        const preferred = found.find((ip) => ipFamily(ip) === 4) || found[0];
        return preferred ? makeObservation(preferred, '本机网络参考', '', 'network-reference') : null;
    }

    async function loadLocalReference(runId) {
        try {
            const observation = await loadBrowserNetworkReference();
            if (runId !== activeRunId) return;
            localReference.status = observation ? 'success' : 'error';
            localReference.observation = observation;
            if (observation) {
                setSource(
                    'localref',
                    'success',
                    '已获取',
                    `STUN：stun.cloudflare.com / stun.l.google.com · IPv${observation.family} ${observation.ip} · 仅供参考，不参与分流判断`
                );
            } else {
                setSource(
                    'localref',
                    'idle',
                    '未获取',
                    'STUN：stun.cloudflare.com / stun.l.google.com · 浏览器未提供可用公网候选 · 不影响国内/国际 HTTP 检测'
                );
            }
        } catch (error) {
            if (runId !== activeRunId) return;
            localReference.status = 'error';
            localReference.observation = null;
            setSource(
                'localref',
                'idle',
                '未获取',
                `STUN：stun.cloudflare.com / stun.l.google.com · ${formatError(error)} · 不影响国内/国际 HTTP 检测`
            );
        }
    }

    async function loadDomestic(runId) {
        const pconlineTask = (async () => {
            try {
                const observation = await loadPconline();
                if (runId !== activeRunId) return null;
                setSource(
                    'pconline',
                    'success',
                    '正常',
                    joinText(['whois.pconline.com.cn', `IPv${observation.family} ${observation.ip}`, observation.detail, '国内主检测'])
                );
                return observation;
            } catch (error) {
                if (runId !== activeRunId) return null;
                const invalid = /非公网 IP/.test(formatError(error));
                setSource(
                    'pconline',
                    'warning',
                    invalid ? '已忽略' : '未响应',
                    joinText(['whois.pconline.com.cn', formatError(error), '国内主检测'])
                );
                return null;
            }
        })();

        const ipwTask = (async () => {
            try {
                const observation = await loadIpw();
                if (runId !== activeRunId) return null;
                setSource('ipw', 'success', '备用正常', `4.ipw.cn · IPv${observation.family} ${observation.ip} · 国内路径备用检测`);
                return observation;
            } catch (error) {
                if (runId !== activeRunId) return null;
                const invalid = /非公网 IP/.test(formatError(error));
                setSource(
                    'ipw',
                    'warning',
                    invalid ? '备用已忽略' : '备用未响应',
                    joinText(['4.ipw.cn', formatError(error), '国内路径备用检测'])
                );
                return null;
            }
        })();

        const [pconline, ipw] = await Promise.all([pconlineTask, ipwTask]);
        if (runId !== activeRunId) return;
        const observations = [pconline, ipw].filter(Boolean);

        if (observations.length) {
            const preferred = observations[0];
            routeResults.domestic = {
                status: 'success',
                observations,
                detail: preferred.detail || `来源：${preferred.source}${preferred.role === 'domestic-backup' ? ' 备用检测' : ''}`
            };
        } else {
            routeResults.domestic = {
                status: 'loading',
                observations: [],
                detail: '国内检测服务暂未响应，正在整理参考结果…'
            };
        }
        renderRoute('domestic');
    }

    function firstPartyDetail(data) {
        const network = data && data.network ? data.network : {};
        return joinUniqueText([
            network.country,
            network.region,
            network.city,
            network.asn ? `AS${network.asn}` : '',
            network.organization
        ]);
    }

    async function internationalTask(runId, id, successLabel, endpoint, loader) {
        try {
            const result = await loader();
            if (runId !== activeRunId) return [];
            const observations = Array.isArray(result) ? result : [result];
            const valid = observations.filter(Boolean);
            if (!valid.length) throw new Error('未返回公网 IP');
            const resultDetail = valid
                .map((item) => joinText([`IPv${item.family} ${item.ip}`, item.detail]))
                .join(' / ');
            setSource(id, 'success', successLabel, joinText([endpoint, resultDetail]));
            return valid;
        } catch (error) {
            if (runId !== activeRunId) return [];
            const isIpv6 = id === 'ipify6';
            const isBackup = id === 'backup';
            setSource(
                id,
                isIpv6 ? 'idle' : 'warning',
                isIpv6 ? '未检测到' : (isBackup ? '备用未响应' : '未响应'),
                joinText([endpoint, formatError(error)])
            );
            return [];
        }
    }

    async function loadInternational(runId) {
        const firstPartyUrl = getFirstPartyProbeUrl();
        const tasks = [
            internationalTask(runId, 'firstparty', '正常', 'myip.cfw3.workers.dev', async () => {
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
            internationalTask(runId, 'ipsb', '复核正常', 'api.ip.sb', async () => {
                const data = await fetchJson('https://api.ip.sb/geoip');
                const detail = joinUniqueText([
                    data && data.country,
                    data && data.region,
                    data && data.city,
                    data && (data.isp || data.organization || data.asn_organization)
                ]);
                return makeObservation(data && data.ip, 'IP.SB', detail);
            }),
            internationalTask(runId, 'ipify4', '复核正常', 'api.ipify.org', async () => {
                const data = await fetchJson('https://api.ipify.org?format=json');
                if (!data || ipFamily(data.ip) !== 4) throw new Error('未返回 IPv4');
                return makeObservation(data.ip, 'IPify IPv4');
            }),
            internationalTask(runId, 'ipify6', '复核正常', 'api6.ipify.org', async () => {
                const data = await fetchJson('https://api6.ipify.org?format=json', IPV6_TIMEOUT_MS);
                if (!data || ipFamily(data.ip) !== 6) throw new Error('未返回 IPv6');
                return makeObservation(data.ip, 'IPify IPv6');
            }),
            internationalTask(runId, 'backup', '备用正常', 'ipwho.is', async () => {
                const data = await fetchJson('https://ipwho.is/');
                if (!data || data.success === false) throw new Error('备用服务未返回结果');
                const detail = joinUniqueText([
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
            const preferred = observations.find((item) => item.family === 4) || observations[0];
            routeResults.international = {
                status: 'success',
                observations,
                detail: preferred.detail || `来源：${preferred.source}`
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

    function finalizeDomesticReference() {
        if (routeResults.domestic.status === 'success') return;

        if (localReference.observation) {
            const reference = localReference.observation;
            routeResults.domestic = {
                status: 'reference',
                observations: [reference],
                detail: '本机网络参考，不代表已确认的国内网站出口。'
            };
            renderRoute('domestic');
            return;
        }

        if (routeResults.international.status === 'success') {
            const source = preferredAnyObservation('international');
            if (source) {
                const reference = {
                    ...source,
                    source: '已确认公网 IP',
                    role: 'generic-reference'
                };
                routeResults.domestic = {
                    status: 'reference',
                    observations: [reference],
                    detail: '国内路径未确认，暂显示已确认的公网 IP 作为参考。'
                };
                renderRoute('domestic');
                return;
            }
        }

        routeResults.domestic = {
            status: 'error',
            observations: [],
            detail: '国内网站 IP 暂未确认。'
        };
        renderRoute('domestic');
    }

    async function runAll() {
        activeRunId += 1;
        const runId = activeRunId;
        resetRoutes();
        resetSources();
        await Promise.all([
            loadDomestic(runId),
            loadInternational(runId),
            loadLocalReference(runId)
        ]);
        if (runId !== activeRunId) return;
        finalizeDomesticReference();
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
