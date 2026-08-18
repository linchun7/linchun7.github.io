(() => {
    'use strict';

    const REQUEST_TIMEOUT_MS = 4500;
    const IPV6_TIMEOUT_MS = 2800;
    const LOCAL_REFERENCE_TIMEOUT_MS = 2800;
    const DOMESTIC_PRIORITY = ['pconline', 'sohu', 'tencent', 'ipip'];
    const INTERNATIONAL_IPV4_PRIORITY = ['firstparty', 'ipsb', 'ipify4', 'backup'];

    const routeResults = {
        domestic: { status: 'idle', observations: [], detail: '' },
        international: { status: 'idle', observations: [], detail: '' }
    };
    const localReference = { status: 'idle', observation: null };
    let activeRunId = 0;

    const $ = (id) => document.getElementById(id);
    const normalizeText = (value) => value === null || value === undefined ? '' : String(value).trim();
    const joinText = (values) => values.map(normalizeText).filter(Boolean).join(' · ');

    function joinUniqueText(values) {
        const seen = new Set();
        return values.map(normalizeText).filter(Boolean).filter((value) => {
            const key = value.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).join(' · ');
    }

    function parseIpv4(value) {
        const text = normalizeText(value);
        if (!/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(text)) return null;
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
        if (/^fe[89ab]/.test(text) || text.startsWith('ff')) return false;
        if (text.startsWith('2001:db8') || text.startsWith('::ffff:')) return false;
        return true;
    }

    function ipFamily(value) {
        if (parseIpv4(value)) return 4;
        if (isIpv6Address(value)) return 6;
        return null;
    }

    function isPublicIpAddress(value) {
        const family = ipFamily(value);
        return family === 4 ? isPublicIpv4(value) : family === 6 ? isPublicIpv6(value) : false;
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
                    referrerPolicy: 'no-referrer',
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
        const raw = normalizeText(document.querySelector('meta[name="myip-first-party-probe"]')?.getAttribute('content'));
        if (!raw) return '';
        try {
            const url = new URL(raw);
            return url.protocol === 'https:' ? url.href : '';
        } catch {
            return '';
        }
    }

    function makeObservation(ip, source, detail = '', sourceId = '') {
        const normalized = normalizeText(ip);
        if (!isPublicIpAddress(normalized)) throw new Error(`${source} 返回了非公网 IP，已忽略`);
        return { ip: normalized, family: ipFamily(normalized), source, sourceId, detail: normalizeText(detail) };
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
            setText('domestic-ip-label', observation ? `${current.status === 'reference' ? '参考 ' : ''}IPv${observation.family}` : 'IPv4');
        } else {
            setText('international-ipv4', displayIp('international', 4));
            setText('international-ipv6', displayIp('international', 6));
        }
        setText(`${route}-detail`, current.detail || '正在获取网络信息…');
        if (current.status === 'loading' || current.status === 'idle') setStatus(`${route}-status`, 'loading', '检测中');
        else if (current.status === 'error') setStatus(`${route}-status`, 'warning', '未获取');
        else if (current.status === 'reference') setStatus(`${route}-status`, 'warning', '参考');
        else setStatus(`${route}-status`, 'success', '已获取');
        renderSummary();
    }

    function compareFamily(family) {
        const domestic = preferredObservation('domestic', family);
        const international = preferredObservation('international', family);
        if (!domestic || !international) return null;
        return { same: domestic.ip === international.ip };
    }

    function renderSummary() {
        const domesticFinal = routeIsFinal('domestic');
        const internationalFinal = routeIsFinal('international');
        const domesticOk = routeResults.domestic.status === 'success';
        const domesticReference = routeResults.domestic.status === 'reference';
        const internationalOk = routeResults.international.status === 'success';

        if (!domesticFinal || !internationalFinal) {
            setStatus('summary-status', 'loading', '检测中');
            setText('summary-main', '正在检测…');
            setText('summary-detail', '请稍候');
            return;
        }

        setText('summary-detail', '');
        if (domesticOk && internationalOk) {
            const comparisons = [compareFamily(4), compareFamily(6)].filter(Boolean);
            if (comparisons.some((item) => !item.same)) {
                setStatus('summary-status', 'warning', '已分流');
                setText('summary-main', '国内外访问使用不同出口');
                return;
            }
            if (comparisons.some((item) => item.same)) {
                setStatus('summary-status', 'success', '同一出口');
                setText('summary-main', '国内外访问使用同一出口');
                return;
            }
            setStatus('summary-status', 'success', '已获取');
            setText('summary-main', '国内外 IP 均已获取');
            return;
        }

        setStatus('summary-status', 'warning', '部分结果');
        if (domesticReference && internationalOk) setText('summary-main', '国际 IP 已获取，国内未确认');
        else if (domesticOk && !internationalOk) setText('summary-main', '国内 IP 已获取，国际未确认');
        else if (!domesticOk && internationalOk) setText('summary-main', '国际 IP 已获取，国内未确认');
        else {
            setStatus('summary-status', 'error', '未获取');
            setText('summary-main', '暂未获取可用结果');
        }
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
        setSource('pconline', 'loading', '检测中', 'whois.pconline.com.cn');
        setSource('sohu', 'loading', '检测中', 'pv.sohu.com');
        setSource('tencent', 'loading', '检测中', 'r.inews.qq.com');
        setSource('ipip', 'loading', '检测中', 'myip.ipip.net');
        setSource('localref', 'loading', '检测中', 'stun.cloudflare.com / stun.l.google.com');
        setSource('firstparty', 'loading', '检测中', 'myip.cfw3.workers.dev');
        setSource('ipsb', 'loading', '检测中', 'api.ip.sb');
        setSource('ipify4', 'loading', '检测中', 'api.ipify.org');
        setSource('backup', 'loading', '检测中', 'ipwho.is');
        setSource('ipify6', 'loading', '检测中', 'api6.ipify.org');
    }

    function loadJsonp(baseUrl, timeoutMs = REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const callbackName = `__myipJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const script = document.createElement('script');
            let settled = false;
            const finish = (handler, value) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                script.remove();
                try { delete window[callbackName]; } catch { window[callbackName] = undefined; }
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

    function loadGlobalScript(baseUrl, globalName, timeoutMs = REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            let settled = false;
            try { delete window[globalName]; } catch { window[globalName] = undefined; }
            const finish = (handler, value) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                script.remove();
                handler(value);
            };
            script.async = true;
            script.referrerPolicy = 'no-referrer';
            script.onerror = () => finish(reject, new Error('加载失败'));
            script.onload = () => window[globalName] ? finish(resolve, window[globalName]) : finish(reject, new Error('未返回结果'));
            const url = new URL(baseUrl);
            url.searchParams.set('_', String(Date.now()));
            script.src = url.href;
            const timer = window.setTimeout(() => finish(reject, createTimeoutError()), timeoutMs);
            document.head.appendChild(script);
        });
    }

    function domesticLocationDetail(payload, ip) {
        const province = normalizeText(payload?.pro);
        const city = normalizeText(payload?.city);
        const region = normalizeText(payload?.region);
        let operator = normalizeText(payload?.isp);
        let address = normalizeText(payload?.addr);
        if (address && address !== ip) {
            for (const prefix of [province, city, region].filter(Boolean)) address = address.replace(prefix, '').trim();
        }
        if (!operator) operator = address;
        return joinUniqueText([payload?.country || payload?.nation, province, city, region, operator]);
    }

    async function loadPconline() {
        const payload = await loadJsonp('https://whois.pconline.com.cn/ipJson.jsp');
        const ip = normalizeText(payload?.ip);
        return makeObservation(ip, '太平洋网络', domesticLocationDetail(payload, ip), 'pconline');
    }

    async function loadSohu() {
        const payload = await loadGlobalScript('https://pv.sohu.com/cityjson?ie=utf-8', 'returnCitySN');
        return makeObservation(payload?.cip, '搜狐', normalizeText(payload?.cname), 'sohu');
    }

    async function loadTencent() {
        const payload = await loadJsonp('https://r.inews.qq.com/api/ip2city?otype=jsonp');
        return makeObservation(payload?.ip, '腾讯新闻', joinUniqueText([payload?.country, payload?.province, payload?.city, payload?.district, payload?.isp]), 'tencent');
    }

    async function loadIpip() {
        const payload = await fetchJson('https://myip.ipip.net/json');
        if (!payload || payload.ret !== 'ok' || !payload.data) throw new Error('返回格式不正确');
        return makeObservation(payload.data.ip, 'IPIP.NET', joinUniqueText(Array.isArray(payload.data.location) ? payload.data.location : []), 'ipip');
    }

    function getCandidateAddress(candidate) {
        if (!candidate) return '';
        if (candidate.address) return normalizeText(candidate.address);
        const parts = normalizeText(candidate.candidate).split(/\s+/);
        return parts.length >= 6 ? normalizeText(parts[4]) : '';
    }

    async function loadBrowserNetworkReference() {
        const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (typeof PeerConnection !== 'function') return null;
        let pc;
        const found = [];
        try {
            pc = new PeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }] });
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
                    if (!event.candidate) return finish();
                    if (!['srflx', 'relay'].includes(normalizeText(event.candidate.type))) return;
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
            if (pc) pc.close();
        }
        const preferred = found.find((ip) => ipFamily(ip) === 4) || found[0];
        return preferred ? makeObservation(preferred, '网络参考', '', 'localref') : null;
    }

    async function loadLocalReference(runId) {
        try {
            const observation = await loadBrowserNetworkReference();
            if (runId !== activeRunId) return;
            localReference.status = observation ? 'success' : 'error';
            localReference.observation = observation;
            if (observation) setSource('localref', 'success', '已获取', `stun.cloudflare.com / stun.l.google.com · IPv${observation.family} ${observation.ip} · 仅供参考`);
            else setSource('localref', 'idle', '未获取', 'stun.cloudflare.com / stun.l.google.com · 未返回公网地址');
        } catch (error) {
            if (runId !== activeRunId) return;
            localReference.status = 'error';
            localReference.observation = null;
            setSource('localref', 'idle', '未获取', `stun.cloudflare.com / stun.l.google.com · ${formatError(error)}`);
        }
    }

    function agreementSummary(observations, family) {
        const relevant = observations.filter((item) => item.family === family);
        if (!relevant.length) return '';
        const unique = new Set(relevant.map((item) => item.ip));
        if (relevant.length === 1) return '仅 1 个来源成功';
        if (unique.size === 1) return `${relevant.length} 个来源一致`;
        return `发现 ${unique.size} 个不同出口`;
    }

    function sourceOutcomeStatus(observation, adopted) {
        if (!observation || !adopted) return null;
        if (observation.sourceId === adopted.sourceId) return { state: 'success', text: '采用' };
        if (observation.family !== adopted.family) return { state: 'success', text: `IPv${observation.family}` };
        if (observation.ip === adopted.ip) return { state: 'success', text: '一致' };
        return { state: 'warning', text: '其他出口' };
    }

    async function runDomesticSource(runId, config) {
        try {
            const observation = await config.loader();
            return runId === activeRunId ? { ...config, observation } : { ...config, observation: null };
        } catch (error) {
            return { ...config, observation: null, error };
        }
    }

    function renderDomesticSourceOutcomes(outcomes, adopted) {
        for (const { id, endpoint, observation, error } of outcomes) {
            if (observation) {
                const status = sourceOutcomeStatus(observation, adopted);
                setSource(id, status.state, status.text, joinText([endpoint, `IPv${observation.family} ${observation.ip}`, observation.detail]));
            } else {
                const invalid = /非公网 IP/.test(formatError(error));
                setSource(id, 'warning', invalid ? '已忽略' : '未响应', joinText([endpoint, formatError(error)]));
            }
        }
    }

    async function loadDomestic(runId) {
        const configs = [
            { id: 'pconline', endpoint: 'whois.pconline.com.cn', loader: loadPconline },
            { id: 'sohu', endpoint: 'pv.sohu.com', loader: loadSohu },
            { id: 'tencent', endpoint: 'r.inews.qq.com', loader: loadTencent },
            { id: 'ipip', endpoint: 'myip.ipip.net', loader: loadIpip }
        ];
        const outcomes = await Promise.all(configs.map((config) => runDomesticSource(runId, config)));
        if (runId !== activeRunId) return;
        const observations = outcomes.filter((item) => item.observation).map((item) => item.observation);
        const adopted = DOMESTIC_PRIORITY.map((id) => observations.find((item) => item.sourceId === id && item.family === 4)).find(Boolean)
            || DOMESTIC_PRIORITY.map((id) => observations.find((item) => item.sourceId === id)).find(Boolean)
            || null;
        renderDomesticSourceOutcomes(outcomes, adopted);
        if (adopted) {
            routeResults.domestic = {
                status: 'success',
                observations: [adopted, ...observations.filter((item) => item !== adopted)],
                detail: joinText([adopted.detail, agreementSummary(observations, adopted.family)])
            };
        } else {
            routeResults.domestic = { status: 'loading', observations: [], detail: '国内网络暂未确认…' };
        }
        renderRoute('domestic');
    }

    function networkDetail(data) {
        const network = data?.network || {};
        return joinUniqueText([network.country, network.region, network.city, network.asn ? `AS${network.asn}` : '', network.organization]);
    }

    async function runInternationalSource(runId, config) {
        try {
            const result = await config.loader();
            const observations = (Array.isArray(result) ? result : [result]).filter(Boolean);
            if (!observations.length) throw new Error('未返回公网 IP');
            return runId === activeRunId ? { ...config, observations } : { ...config, observations: [] };
        } catch (error) {
            return { ...config, observations: [], error };
        }
    }

    function renderInternationalSourceOutcomes(outcomes, adoptedV4, adoptedV6) {
        for (const { id, endpoint, observations, error } of outcomes) {
            if (observations?.length) {
                const current = observations.find((item) => item.family === 4) || observations[0];
                const target = current.family === 4 ? adoptedV4 : adoptedV6;
                const status = sourceOutcomeStatus(current, target);
                const detail = observations.map((item) => joinText([`IPv${item.family} ${item.ip}`, item.detail])).join(' / ');
                setSource(id, status ? status.state : 'success', status ? status.text : '正常', joinText([endpoint, detail]));
            } else {
                const ipv6 = id === 'ipify6';
                setSource(id, ipv6 ? 'idle' : 'warning', ipv6 ? '未检测到' : '未响应', joinText([endpoint, formatError(error)]));
            }
        }
    }

    async function loadInternational(runId) {
        const firstPartyUrl = getFirstPartyProbeUrl();
        const configs = [
            {
                id: 'firstparty', endpoint: 'myip.cfw3.workers.dev', loader: async () => {
                    if (!firstPartyUrl) throw new Error('检测地址未配置');
                    const data = await fetchJson(firstPartyUrl);
                    if (!data || data.schemaVersion !== 1 || data.role !== 'international-first-party') throw new Error('返回格式不正确');
                    const detail = networkDetail(data);
                    const results = [makeObservation(data.ip, '国际检测', detail, 'firstparty')];
                    if (data.originalIpv6 && normalizeText(data.originalIpv6) !== normalizeText(data.ip)) results.push(makeObservation(data.originalIpv6, '国际检测 IPv6', detail, 'firstparty'));
                    return results;
                }
            },
            {
                id: 'ipsb', endpoint: 'api.ip.sb', loader: async () => {
                    const data = await fetchJson('https://api.ip.sb/geoip');
                    return makeObservation(data?.ip, 'IP.SB', joinUniqueText([data?.country, data?.region, data?.city, data?.isp || data?.organization || data?.asn_organization]), 'ipsb');
                }
            },
            {
                id: 'ipify4', endpoint: 'api.ipify.org', loader: async () => {
                    const data = await fetchJson('https://api.ipify.org?format=json');
                    if (!data || ipFamily(data.ip) !== 4) throw new Error('未返回 IPv4');
                    return makeObservation(data.ip, 'IPify', '', 'ipify4');
                }
            },
            {
                id: 'backup', endpoint: 'ipwho.is', loader: async () => {
                    const data = await fetchJson('https://ipwho.is/');
                    if (!data || data.success === false) throw new Error('未返回结果');
                    return makeObservation(data.ip, 'IPWho.is', joinUniqueText([data.country, data.region, data.city, data.connection?.isp || data.connection?.org]), 'backup');
                }
            },
            {
                id: 'ipify6', endpoint: 'api6.ipify.org', loader: async () => {
                    const data = await fetchJson('https://api6.ipify.org?format=json', IPV6_TIMEOUT_MS);
                    if (!data || ipFamily(data.ip) !== 6) throw new Error('未返回 IPv6');
                    return makeObservation(data.ip, 'IPify IPv6', '', 'ipify6');
                }
            }
        ];

        const outcomes = await Promise.all(configs.map((config) => runInternationalSource(runId, config)));
        if (runId !== activeRunId) return;
        const observations = outcomes.flatMap((item) => item.observations || []);
        const adoptedV4 = INTERNATIONAL_IPV4_PRIORITY.map((id) => observations.find((item) => item.sourceId === id && item.family === 4)).find(Boolean) || null;
        const adoptedV6 = observations.find((item) => item.sourceId === 'firstparty' && item.family === 6)
            || observations.find((item) => item.sourceId === 'ipify6' && item.family === 6)
            || observations.find((item) => item.family === 6)
            || null;
        const adopted = adoptedV4 || adoptedV6;
        renderInternationalSourceOutcomes(outcomes, adoptedV4, adoptedV6);

        if (adopted) {
            routeResults.international = {
                status: 'success',
                observations: [
                    ...(adoptedV4 ? [adoptedV4] : []),
                    ...(adoptedV6 && adoptedV6 !== adoptedV4 ? [adoptedV6] : []),
                    ...observations.filter((item) => item !== adoptedV4 && item !== adoptedV6)
                ],
                detail: joinText([adopted.detail, agreementSummary(observations, adopted.family)])
            };
        } else {
            routeResults.international = { status: 'error', observations: [], detail: '国际网站 IP 暂未获取。' };
        }
        renderRoute('international');
    }

    function finalizeDomesticReference() {
        if (routeResults.domestic.status === 'success') return;
        if (localReference.observation) {
            routeResults.domestic = {
                status: 'reference',
                observations: [localReference.observation],
                detail: '本机网络参考，不代表已确认的国内网站出口。'
            };
            renderRoute('domestic');
            return;
        }
        if (routeResults.international.status === 'success') {
            const source = preferredAnyObservation('international');
            if (source) {
                routeResults.domestic = {
                    status: 'reference',
                    observations: [{ ...source, source: '公网参考', sourceId: 'generic-reference' }],
                    detail: '国内路径未确认，暂显示已获取的公网 IP 作为参考。'
                };
                renderRoute('domestic');
                return;
            }
        }
        routeResults.domestic = { status: 'error', observations: [], detail: '国内网站 IP 暂未确认。' };
        renderRoute('domestic');
    }

    async function runAll() {
        activeRunId += 1;
        const runId = activeRunId;
        resetRoutes();
        resetSources();
        await Promise.all([loadDomestic(runId), loadInternational(runId), loadLocalReference(runId)]);
        if (runId === activeRunId) finalizeDomesticReference();
    }

    function init() {
        $('retry-all')?.addEventListener('click', runAll);
        runAll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
