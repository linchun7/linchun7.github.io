(() => {
    'use strict';

    const REQUEST_TIMEOUT_MS = 5200;
    const IPV6_TIMEOUT_MS = 2800;
    const WEBRTC_TIMEOUT_MS = 4500;
    const RETRY_DELAY_MS = 420;

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

    function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function isIpAddress(value) {
        const text = normalizeText(value);
        if (!text) return false;

        const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
        if (ipv4.test(text)) return true;

        const ipv6 = text.split('%')[0];
        return ipv6.includes(':') && ipv6.length <= 45 && /^[0-9a-f:.]+$/i.test(ipv6);
    }

    function ipFamily(value) {
        const text = normalizeText(value);
        if (!isIpAddress(text)) return null;
        return text.includes(':') ? 6 : 4;
    }

    class HttpError extends Error {
        constructor(status) {
            super(`HTTP ${status}`);
            this.name = 'HttpError';
            this.status = status;
        }
    }

    function createTimeoutError(label = '请求') {
        const error = new Error(`${label}超时`);
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

    function shouldRetry(error) {
        if (!error) return true;
        if (error.name === 'HttpError') {
            return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
        }
        return true;
    }

    async function withRetry(task, { attempts = 2, delayMs = RETRY_DELAY_MS } = {}) {
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                return await task(attempt);
            } catch (error) {
                lastError = error;
                if (attempt >= attempts || !shouldRetry(error)) break;
                await sleep(delayMs * attempt);
            }
        }
        throw lastError;
    }

    function formatError(error) {
        if (!error) return '请求失败';
        if (error.name === 'TimeoutError') return '连接超时';
        if (error.name === 'HttpError') return `服务返回 HTTP ${error.status}`;
        if (error instanceof TypeError) return '浏览器阻止或网络连接失败';
        return normalizeText(error.message) || '请求失败';
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

    function makeObservation(ip, source, detail = '') {
        const normalized = normalizeText(ip);
        if (!isIpAddress(normalized)) throw new Error(`${source} 未返回有效 IP`);
        return { ip: normalized, family: ipFamily(normalized), source, detail: normalizeText(detail) };
    }

    function uniqueIps(route, family) {
        const observations = routeResults[route].observations || [];
        return [...new Set(observations.filter((item) => item.family === family).map((item) => item.ip))];
    }

    function formatIpList(ips, pending) {
        if (ips.length) return ips.join(' · ');
        return pending ? '检测中…' : '未检测到';
    }

    function routeIsFinal(route) {
        return routeResults[route].status === 'success' || routeResults[route].status === 'error';
    }

    function routeHasMultipleSameFamily(route) {
        return uniqueIps(route, 4).length > 1 || uniqueIps(route, 6).length > 1;
    }

    function renderRoute(route) {
        const current = routeResults[route];
        const pending = current.status === 'loading' || current.status === 'idle';
        const ipv4 = uniqueIps(route, 4);
        const ipv6 = uniqueIps(route, 6);

        setText(`${route}-ipv4`, formatIpList(ipv4, pending));
        setText(`${route}-ipv6`, formatIpList(ipv6, pending));
        setText(`${route}-detail`, current.detail || (route === 'domestic'
            ? '请求国内站点，用于观察 DIRECT / 直连规则实际使用的出口。'
            : '请求国际 IP 服务，用于观察代理、VPN 或国际策略路由实际使用的出口。'));

        if (current.status === 'loading' || current.status === 'idle') {
            setStatus(`${route}-status`, 'loading', '检测中');
        } else if (current.status === 'error') {
            setStatus(`${route}-status`, 'warning', '未确认');
        } else if (routeHasMultipleSameFamily(route)) {
            setStatus(`${route}-status`, 'warning', '多出口');
        } else if (ipv4.length && ipv6.length) {
            setStatus(`${route}-status`, 'success', '双栈');
        } else {
            setStatus(`${route}-status`, 'success', '已获取');
        }

        renderSummary();
    }

    function compareFamily(family) {
        const domestic = uniqueIps('domestic', family);
        const international = uniqueIps('international', family);
        if (!domestic.length || !international.length) return null;
        const shared = domestic.some((ip) => international.includes(ip));
        return { family, same: shared, domestic, international };
    }

    function shortRouteValue(route) {
        const v4 = uniqueIps(route, 4);
        const v6 = uniqueIps(route, 6);
        if (v4.length) return v4[0];
        if (v6.length) return v6[0];
        return routeIsFinal(route) ? '未确认' : '检测中';
    }

    function renderSummary() {
        setText('summary-domestic', shortRouteValue('domestic'));
        setText('summary-international', shortRouteValue('international'));

        const domesticFinal = routeIsFinal('domestic');
        const internationalFinal = routeIsFinal('international');
        const domesticOk = routeResults.domestic.status === 'success';
        const internationalOk = routeResults.international.status === 'success';

        if (!domesticFinal || !internationalFinal) {
            setStatus('summary-status', 'loading', '检测中');
            setText('summary-routing', '待确认');
            if (domesticOk || internationalOk) {
                setText('summary-main', '已获取部分出口，仍在完成其余线路探测…');
                setText('summary-detail', '已成功的结果会立即保留；单个服务重试或失败不会覆盖其他线路。');
            } else {
                setText('summary-main', '正在识别国内与国际请求路径…');
                setText('summary-detail', '如果代理软件按域名或规则分流，本页会分别展示国内直连出口和国际代理出口。');
            }
            return;
        }

        if (!domesticOk && !internationalOk) {
            setStatus('summary-status', 'error', '未确认');
            setText('summary-routing', '无法判断');
            setText('summary-main', '未能确认当前公网出口');
            setText('summary-detail', '多个独立探测都未成功。可重新检测，并检查浏览器隐私插件、代理规则或当前网络是否阻止了跨站请求。');
            return;
        }

        if (!domesticOk || !internationalOk) {
            setStatus('summary-status', 'warning', '部分结果');
            setText('summary-routing', '证据不足');
            setText('summary-main', '已获取部分线路出口');
            setText('summary-detail', domesticOk
                ? '国内线路已确认，但国际线路没有足够结果，因此暂不判断是否存在代理分流。'
                : '国际线路已确认，但国内线路没有足够结果，因此暂不判断是否存在代理分流。');
            return;
        }

        const comparisons = [compareFamily(4), compareFamily(6)].filter(Boolean);
        const splitComparisons = comparisons.filter((item) => !item.same);
        const sameComparisons = comparisons.filter((item) => item.same);
        const multiInternational = routeHasMultipleSameFamily('international');

        if (splitComparisons.length) {
            const evidence = splitComparisons.map((item) => {
                const label = `IPv${item.family}`;
                return `${label} 国内 ${item.domestic.join(' / ')}；国际 ${item.international.join(' / ')}`;
            }).join('。');
            setStatus('summary-status', 'warning', '已分流');
            setText('summary-routing', '国内 / 国际不同出口');
            setText('summary-main', '检测到国内 / 国际不同出口');
            setText('summary-detail', `${evidence}。这通常符合代理软件按域名、区域或规则分流后的预期表现。`);
            return;
        }

        if (multiInternational) {
            setStatus('summary-status', 'warning', '多出口');
            setText('summary-routing', '国际源存在差异');
            setText('summary-main', '国际探测源使用了多个出口');
            setText('summary-detail', '不同国际域名返回了不同的同地址族 IP，常见于不同代理组、策略路由或代理节点负载分配。');
            return;
        }

        if (sameComparisons.length) {
            const families = sameComparisons.map((item) => `IPv${item.family}`).join(' / ');
            setStatus('summary-status', 'success', '单一出口');
            setText('summary-routing', '未见明显分流');
            setText('summary-main', '当前未检测到明显的国内 / 国际分流');
            setText('summary-detail', `${families} 的国内与国际探测返回相同出口。若你启用了代理，这可能表示当前规则走全局、同一节点或探测域名被分到同一路径。`);
            return;
        }

        setStatus('summary-status', 'success', '已获取');
        setText('summary-routing', '地址族不同');
        setText('summary-main', '已获取国内与国际出口信息');
        setText('summary-detail', '两条线路当前没有可直接比较的同地址族结果。IPv4 与 IPv6 不同本身不能证明存在代理分流。');
    }

    function resetRoutes() {
        routeResults.domestic = { status: 'loading', observations: [], detail: '' };
        routeResults.international = { status: 'loading', observations: [], detail: '' };
        renderRoute('domestic');
        renderRoute('international');
    }

    async function loadPconlineJsonp(timeoutMs = REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const callbackName = `__myipPconline_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const script = document.createElement('script');
            let settled = false;

            const cleanup = () => {
                window.clearTimeout(timer);
                script.remove();
                try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
            };

            const finish = (handler, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                handler(value);
            };

            const timer = window.setTimeout(() => finish(reject, createTimeoutError('国内备用接口')), timeoutMs);
            window[callbackName] = (payload) => finish(resolve, payload);
            script.async = true;
            script.referrerPolicy = 'no-referrer';
            script.onerror = () => finish(reject, new Error('国内备用接口加载失败'));
            script.src = `https://whois.pconline.com.cn/ipJson.jsp?json=true&callback=${encodeURIComponent(callbackName)}&_=${Date.now()}`;
            document.head.appendChild(script);
        });
    }

    async function loadDomestic(runId) {
        setSource('domestic', 'loading', '检测中', '优先国内 HTTPS API，必要时切换国内备用接口。');

        try {
            const data = await withRetry(() => fetchJson('https://api.bilibili.com/x/web-interface/zone'));
            if (runId !== activeRunId) return;
            if (!data || data.code !== 0 || !data.data || !isIpAddress(data.data.addr)) {
                throw new Error('国内主接口未返回有效 IP');
            }

            const detail = joinText([data.data.country, data.data.province, data.data.city, data.data.isp]);
            routeResults.domestic = {
                status: 'success',
                observations: [makeObservation(data.data.addr, 'Bilibili', detail)],
                detail: detail
                    ? `国内站点返回：${detail}。用于观察 DIRECT / 直连规则实际出口。`
                    : '已通过国内站点确认请求出口，用于观察 DIRECT / 直连规则实际路径。'
            };
            setSource('domestic', 'success', '已获取', 'Bilibili 国内线路探测成功。');
            renderRoute('domestic');
            return;
        } catch (primaryError) {
            if (runId !== activeRunId) return;
            setSource('domestic', 'warning', '切换备用', `主接口未确认（${formatError(primaryError)}），正在尝试太平洋网络备用接口。`);
        }

        try {
            const payload = await withRetry(() => loadPconlineJsonp(), { attempts: 2 });
            if (runId !== activeRunId) return;
            const ip = normalizeText(payload && (payload.ip || payload.addr));
            if (!isIpAddress(ip)) throw new Error('国内备用接口未返回有效 IP');
            const detail = joinText([
                payload.country || payload.nation,
                payload.pro,
                payload.city,
                payload.region,
                payload.addr && payload.addr !== ip ? payload.addr : '',
                payload.isp
            ]);
            routeResults.domestic = {
                status: 'success',
                observations: [makeObservation(ip, 'PConline', detail)],
                detail: detail
                    ? `国内备用站点返回：${detail}。用于观察 DIRECT / 直连规则实际出口。`
                    : '已通过国内备用站点确认请求出口，用于观察 DIRECT / 直连规则实际路径。'
            };
            setSource('domestic', 'success', '备用成功', 'Bilibili 未确认，已由太平洋网络国内备用接口返回结果。');
        } catch (fallbackError) {
            if (runId !== activeRunId) return;
            routeResults.domestic = {
                status: 'error',
                observations: [],
                detail: `国内线路未确认：${formatError(fallbackError)}。这不代表网络断开，可能是浏览器或代理规则阻止了探测域名。`
            };
            setSource('domestic', 'warning', '未确认', `国内主、备用接口均未成功：${formatError(fallbackError)}。`);
        }

        renderRoute('domestic');
    }

    async function loadInternational(runId) {
        setSource('ipsb', 'loading', '检测中', '国际公网地址与归属信息。');
        setSource('ipify4', 'loading', '检测中', '独立 IPv4 出口复核。');
        setSource('ipify6', 'loading', '检测中', '独立 IPv6 出口探测；无 IPv6 时允许失败。');
        setSource('fallback', 'idle', '待命', '仅在主要国际数据源全部失败时按需启用。');

        const observations = [];
        let geoDetail = '';

        const ipsbTask = (async () => {
            try {
                const data = await withRetry(() => fetchJson('https://api.ip.sb/geoip'));
                if (runId !== activeRunId) return;
                if (!data || !isIpAddress(data.ip)) throw new Error('IP.SB 未返回有效 IP');
                geoDetail = joinText([data.country, data.region, data.city, data.isp || data.organization || data.asn_organization]);
                observations.push(makeObservation(data.ip, 'IP.SB', geoDetail));
                setSource('ipsb', 'success', '已获取', geoDetail || 'IP.SB 已返回公网地址。');
                routeResults.international = { status: 'loading', observations: [...observations], detail: geoDetail };
                renderRoute('international');
            } catch (error) {
                if (runId !== activeRunId) return;
                setSource('ipsb', 'warning', '未确认', formatError(error));
            }
        })();

        const ipify4Task = (async () => {
            try {
                const data = await withRetry(() => fetchJson('https://api.ipify.org?format=json'));
                if (runId !== activeRunId) return;
                if (!data || ipFamily(data.ip) !== 4) throw new Error('IPify IPv4 未返回有效 IPv4');
                observations.push(makeObservation(data.ip, 'IPify IPv4'));
                setSource('ipify4', 'success', '已获取', `IPv4 ${data.ip}`);
                routeResults.international = { status: 'loading', observations: [...observations], detail: geoDetail };
                renderRoute('international');
            } catch (error) {
                if (runId !== activeRunId) return;
                setSource('ipify4', 'warning', '未确认', formatError(error));
            }
        })();

        const ipify6Task = (async () => {
            try {
                const data = await fetchJson('https://api6.ipify.org?format=json', IPV6_TIMEOUT_MS);
                if (runId !== activeRunId) return;
                if (!data || ipFamily(data.ip) !== 6) throw new Error('当前路径未返回 IPv6');
                observations.push(makeObservation(data.ip, 'IPify IPv6'));
                setSource('ipify6', 'success', '已获取', `IPv6 ${data.ip}`);
                routeResults.international = { status: 'loading', observations: [...observations], detail: geoDetail };
                renderRoute('international');
            } catch (error) {
                if (runId !== activeRunId) return;
                setSource('ipify6', 'idle', '未检测到', '当前网络没有可用 IPv6，或 IPv6 请求被代理 / 网络策略阻断。');
            }
        })();

        await Promise.allSettled([ipsbTask, ipify4Task, ipify6Task]);
        if (runId !== activeRunId) return;

        if (observations.length === 0) {
            setSource('fallback', 'loading', '启用备用', '主要国际数据源均未确认，正在使用 IPWho.is 备用探测。');
            try {
                const data = await withRetry(() => fetchJson('https://ipwho.is/'), { attempts: 2 });
                if (runId !== activeRunId) return;
                if (!data || data.success === false || !isIpAddress(data.ip)) throw new Error('国际备用接口未返回有效 IP');
                const detail = joinText([data.country, data.region, data.city, data.connection && (data.connection.isp || data.connection.org)]);
                observations.push(makeObservation(data.ip, 'IPWho.is', detail));
                geoDetail = detail;
                setSource('fallback', 'success', '备用成功', detail || `IP ${data.ip}`);
            } catch (error) {
                if (runId !== activeRunId) return;
                setSource('fallback', 'warning', '未确认', formatError(error));
            }
        }

        if (observations.length) {
            const distinctV4 = [...new Set(observations.filter((item) => item.family === 4).map((item) => item.ip))];
            const distinctV6 = [...new Set(observations.filter((item) => item.family === 6).map((item) => item.ip))];
            const parts = [];
            if (geoDetail) parts.push(geoDetail);
            if (distinctV4.length > 1 || distinctV6.length > 1) {
                parts.push('不同国际探测域名返回了多个同地址族出口，可能存在更细粒度的代理规则或代理组分流');
            } else {
                parts.push('用于观察代理、VPN 或国际策略路由实际出口');
            }
            routeResults.international = { status: 'success', observations: [...observations], detail: parts.join('。') + '。' };
        } else {
            routeResults.international = {
                status: 'error',
                observations: [],
                detail: '国际线路未确认。多个独立国际服务均未成功，这不等同于“无法访问国际网络”；浏览器插件、代理规则或网络策略也可能阻止探测。'
            };
        }
        renderRoute('international');
    }

    function getCandidateAddress(candidate) {
        if (!candidate) return '';
        if (candidate.address) return normalizeText(candidate.address);
        const raw = normalizeText(candidate.candidate);
        const parts = raw.split(/\s+/);
        return parts.length >= 6 ? normalizeText(parts[4]) : '';
    }

    async function collectWebRtcCandidates() {
        const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (typeof PeerConnection !== 'function') {
            return { state: 'unsupported', title: '浏览器未提供 WebRTC', detail: 'HTTP 出口与分流检测不受影响。' };
        }

        let pc;
        const found = new Map();
        let sawMdns = false;
        let sawHost = false;

        try {
            pc = new PeerConnection({
                iceServers: [
                    { urls: 'stun:stun.cloudflare.com:3478' },
                    { urls: 'stun:stun.l.google.com:19302' }
                ]
            });
            pc.createDataChannel('network-probe');

            await new Promise(async (resolve, reject) => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timer);
                    resolve();
                };
                const timer = window.setTimeout(finish, WEBRTC_TIMEOUT_MS);

                pc.onicecandidate = (event) => {
                    if (!event.candidate) {
                        finish();
                        return;
                    }
                    const address = getCandidateAddress(event.candidate);
                    const type = normalizeText(event.candidate.type) || 'candidate';
                    if (/\.local$/i.test(address)) {
                        sawMdns = true;
                        return;
                    }
                    if (type === 'host') {
                        sawHost = true;
                        return;
                    }
                    if (isIpAddress(address)) found.set(`${type}:${address}`, { type, address });
                };

                pc.onicecandidateerror = (event) => {
                    console.warn('WebRTC ICE candidate error:', event && event.errorText ? event.errorText : event);
                };

                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                } catch (error) {
                    reject(error);
                }
            });
        } finally {
            if (pc) {
                pc.onicecandidate = null;
                pc.onicecandidateerror = null;
                pc.close();
            }
        }

        const candidates = [...found.values()];
        if (candidates.length) {
            return {
                state: 'success',
                title: candidates.slice(0, 4).map((item) => `${item.type}: ${item.address}`).join(' · '),
                detail: '仅展示 STUN / relay 等非 host 候选，作为 HTTP 出口之外的辅助网络证据。'
            };
        }
        if (sawMdns || sawHost) {
            return {
                state: 'privacy',
                title: '本地网络候选已隐藏',
                detail: '浏览器只提供 host / mDNS 隐私候选，未暴露可用于辅助判断的 STUN 公网地址。'
            };
        }
        return {
            state: 'privacy',
            title: '浏览器未暴露 STUN 网络候选',
            detail: '可能由浏览器隐私策略、VPN、代理软件的 UDP 策略或 STUN 网络限制导致；HTTP 出口检测不受影响。'
        };
    }

    async function loadWebRtc(runId) {
        setText('webrtc-ip', '检测中…');
        setText('webrtc-detail', '尝试获取 STUN / relay 候选；不会把 WebRTC 结果当作公网出口的唯一依据。');
        setStatus('webrtc-status', 'loading', '检测中');
        try {
            const result = await collectWebRtcCandidates();
            if (runId !== activeRunId) return;
            setText('webrtc-ip', result.title);
            setText('webrtc-detail', result.detail);
            if (result.state === 'success') setStatus('webrtc-status', 'success', '已检测');
            else if (result.state === 'unsupported') setStatus('webrtc-status', 'idle', '不支持');
            else setStatus('webrtc-status', 'warning', '隐私保护');
        } catch (error) {
            if (runId !== activeRunId) return;
            console.warn('WebRTC 检测失败：', error);
            setText('webrtc-ip', 'WebRTC 辅助检测未确认');
            setText('webrtc-detail', formatError(error));
            setStatus('webrtc-status', 'warning', '未确认');
        }
    }

    function runAll() {
        activeRunId += 1;
        const runId = activeRunId;
        resetRoutes();
        loadDomestic(runId);
        loadInternational(runId);
        loadWebRtc(runId);
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
