(() => {
    'use strict';

    const REQUEST_TIMEOUT_MS = 5500;
    const RETRY_DELAY_MS = 450;
    const WEBRTC_TIMEOUT_MS = 4500;
    const REACHABILITY_TIMEOUT_MS = 4500;
    const routeState = new Map();
    let runGeneration = 0;

    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    function normalizeText(value) {
        return value === null || value === undefined ? '' : String(value).trim();
    }

    function joinText(values) {
        return values.map(normalizeText).filter(Boolean).join(' ');
    }

    function ipFamily(value) {
        const text = normalizeText(value);
        if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(text)) return 4;
        const ipv6 = text.split('%')[0];
        if (ipv6.includes(':') && ipv6.length <= 45 && /^[0-9a-f:.]+$/i.test(ipv6)) return 6;
        return 0;
    }

    function isIpAddress(value) {
        return ipFamily(value) !== 0;
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
            if (response.type !== 'opaque' && !response.ok) throw new Error(`HTTP ${response.status}`);
            return response;
        } catch (error) {
            if (error && error.name === 'AbortError') throw createTimeoutError();
            throw error;
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    async function fetchJson(url) {
        const response = await fetchWithTimeout(url, { mode: 'cors', headers: { Accept: 'application/json' } });
        return response.json();
    }

    async function fetchText(url) {
        const response = await fetchWithTimeout(url, { mode: 'cors', headers: { Accept: 'text/plain,*/*;q=0.8' } });
        return response.text();
    }

    async function retry(task, attempts = 2) {
        let lastError;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                return await task();
            } catch (error) {
                lastError = error;
                if (attempt + 1 < attempts) await sleep(RETRY_DELAY_MS * (attempt + 1));
            }
        }
        throw lastError || new Error('请求失败');
    }

    async function firstWorking(sources) {
        const errors = [];
        for (const source of sources) {
            try {
                const result = await retry(source.load, source.attempts || 2);
                if (!result || !isIpAddress(result.ip)) throw new Error('未返回有效 IP');
                return { ...result, source: source.name };
            } catch (error) {
                errors.push(`${source.name}: ${error instanceof Error ? error.message : '请求失败'}`);
            }
        }
        throw new Error(errors.join('；') || '所有探测源均不可用');
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

    function setRouteLoading(id) {
        routeState.set(id, { state: 'loading' });
        setText(`${id}-ip`, '查询中…');
        setText(`${id}-detail`, id === 'route-cn' ? '正在连接国内探测源' : '正在连接国际探测源');
        setStatus(`${id}-status`, 'loading', '检测中');
        updateSummary();
    }

    function setRouteSuccess(id, result) {
        routeState.set(id, { state: 'success', ...result, family: ipFamily(result.ip) });
        setText(`${id}-ip`, result.ip);
        setText(`${id}-detail`, result.detail || `已获取 IPv${ipFamily(result.ip)} 公网地址`);
        setText(`${id}-source`, `当前来源：${result.source}`);
        setStatus(`${id}-status`, 'success', '已获取');
        updateSummary();
    }

    function setRouteError(id, error) {
        routeState.set(id, { state: 'error', error });
        setText(`${id}-ip`, '未能确认');
        setText(`${id}-detail`, error instanceof Error ? error.message : '探测请求失败');
        setStatus(`${id}-status`, 'warning', '未确认');
        updateSummary();
    }

    function updateSummary() {
        const cn = routeState.get('route-cn');
        const global = routeState.get('route-global');
        if (!cn || !global || cn.state === 'loading' || global.state === 'loading') {
            setText('summary-title-value', '正在检测国内与国际出口…');
            setText('summary-detail', '两条链路独立完成后再判断是否存在规则分流。');
            setStatus('summary-status', 'loading', '检测中');
            return;
        }

        if (cn.state !== 'success' && global.state !== 'success') {
            setText('summary-title-value', '暂时无法确认公网出口');
            setText('summary-detail', '国内与国际探测源均未成功返回。可稍后重试，或检查代理、DNS、内容拦截和网络连接。');
            setStatus('summary-status', 'warning', '未确认');
            return;
        }

        if (cn.state !== 'success' || global.state !== 'success') {
            const available = cn.state === 'success' ? '国内' : '国际';
            setText('summary-title-value', `已获取${available}出口，另一侧未确认`);
            setText('summary-detail', '单侧失败不足以判断是否分流；已成功的出口结果仍然有效。');
            setStatus('summary-status', 'warning', '部分完成');
            return;
        }

        if (cn.family !== global.family) {
            setText('summary-title-value', '检测到 IPv4 / IPv6 不同协议出口');
            setText('summary-detail', `国内：${cn.ip} · 国际：${global.ip}。协议不同，不能仅凭地址不同判断代理分流。`);
            setStatus('summary-status', 'success', '双栈结果');
            return;
        }

        if (cn.ip === global.ip) {
            setText('summary-title-value', '国内与国际出口一致');
            setText('summary-detail', `${cn.ip} · 两条探测链路当前使用同一 IPv${cn.family} 公网出口。`);
            setStatus('summary-status', 'success', '同一出口');
            return;
        }

        setText('summary-title-value', '检测到国内 / 国际分流出口');
        setText('summary-detail', `国内：${cn.ip} · 国际：${global.ip}。同为 IPv${cn.family} 且地址不同，通常表示代理、VPN 或规则分流正在生效。`);
        setStatus('summary-status', 'split', '分流生效');
    }

    function parseIpip(text) {
        const value = normalizeText(text);
        const match = value.match(/(?:当前\s*IP[:：]\s*)?([0-9a-f:.]+)(?:\s+来自于[:：]\s*(.*))?/i);
        if (!match || !isIpAddress(match[1])) throw new Error('IPIP 未返回有效 IP');
        return { ip: match[1], detail: normalizeText(match[2]) || 'IPIP 国内出口' };
    }

    const domesticSources = [
        { name: 'IPIP', load: async () => parseIpip(await fetchText('https://myip.ipip.net/')) },
        { name: 'IPW IPv4', load: async () => ({ ip: normalizeText(await fetchText('https://4.ipw.cn/')), detail: 'IPW 国内 IPv4 出口' }) }
    ];

    const globalSources = [
        {
            name: 'IP.SB',
            load: async () => {
                const data = await fetchJson('https://api.ip.sb/geoip');
                return { ip: data && data.ip, detail: joinText([data && data.country, data && data.city, data && data.organization]) };
            }
        },
        {
            name: 'IPify',
            load: async () => {
                const data = await fetchJson('https://api64.ipify.org?format=json');
                return { ip: data && data.ip, detail: 'IPify 国际公网出口' };
            }
        }
    ];

    async function loadRoute(id, sources, generation) {
        setRouteLoading(id);
        try {
            const result = await firstWorking(sources);
            if (generation !== runGeneration) return;
            setRouteSuccess(id, result);
        } catch (error) {
            if (generation !== runGeneration) return;
            console.warn(`${id} 探测失败：`, error);
            setRouteError(id, error);
        }
    }

    async function loadProtocol(id, url, expectedFamily, generation) {
        setText(`${id}-ip`, '查询中…');
        setText(`${id}-detail`, `正在探测 IPv${expectedFamily} 出口`);
        setStatus(`${id}-status`, 'loading', '检测中');
        try {
            const data = await retry(() => fetchJson(url), 2);
            if (generation !== runGeneration) return;
            if (!data || ipFamily(data.ip) !== expectedFamily) throw new Error(`未返回 IPv${expectedFamily} 地址`);
            setText(`${id}-ip`, data.ip);
            setText(`${id}-detail`, `当前网络可通过 IPv${expectedFamily} 访问国际探测端点`);
            setStatus(`${id}-status`, 'success', '可用');
        } catch (error) {
            if (generation !== runGeneration) return;
            setText(`${id}-ip`, '未检测到');
            setText(`${id}-detail`, `当前未确认 IPv${expectedFamily} 连通；这不影响其他协议使用。`);
            setStatus(`${id}-status`, 'neutral', '未确认');
        }
    }

    function getCandidateAddress(candidate) {
        if (!candidate) return '';
        if (candidate.address) return normalizeText(candidate.address);
        const parts = normalizeText(candidate.candidate).split(/\s+/);
        return parts.length >= 6 ? normalizeText(parts[4]) : '';
    }

    async function collectWebRtcCandidates() {
        const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (typeof PeerConnection !== 'function') return { state: 'unsupported', title: '浏览器未提供 WebRTC', detail: '公网出口检测不受影响。' };
        let pc;
        const found = new Map();
        let sawMdns = false;
        try {
            pc = new PeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }] });
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
                    if (!event.candidate) return finish();
                    const address = getCandidateAddress(event.candidate);
                    const type = normalizeText(event.candidate.type) || 'candidate';
                    if (/\.local$/i.test(address)) { sawMdns = true; return; }
                    if (isIpAddress(address)) found.set(`${type}:${address}`, { type, address });
                };
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                } catch (error) { reject(error); }
            });
        } finally {
            if (pc) { pc.onicecandidate = null; pc.close(); }
        }
        const candidates = [...found.values()];
        if (candidates.length) return {
            state: 'success',
            title: candidates.slice(0, 4).map((item) => `${item.type}: ${item.address}`).join(' · '),
            detail: sawMdns ? '同时检测到 mDNS 隐私候选；浏览器隐藏了部分本地地址。' : 'ICE 候选仅用于辅助诊断，不参与分流结论。'
        };
        if (sawMdns) return { state: 'privacy', title: '本地地址已被浏览器隐藏', detail: '检测到 mDNS 候选，这是 Safari/WebKit 等现代浏览器的正常隐私保护。' };
        return { state: 'privacy', title: '浏览器未暴露网络候选', detail: '可能由浏览器隐私策略、VPN、代理或 STUN 网络限制导致。' };
    }

    async function loadWebRtc(generation) {
        setText('webrtc-ip', '检测中…');
        setStatus('webrtc-status', 'loading', '检测中');
        try {
            const result = await collectWebRtcCandidates();
            if (generation !== runGeneration) return;
            setText('webrtc-ip', result.title);
            setText('webrtc-detail', result.detail);
            setStatus('webrtc-status', result.state === 'success' ? 'success' : 'neutral', result.state === 'success' ? '已检测' : result.state === 'unsupported' ? '不支持' : '隐私保护');
        } catch (error) {
            if (generation !== runGeneration) return;
            setText('webrtc-ip', '未能完成 WebRTC 辅助检测');
            setText('webrtc-detail', '不影响国内/国际公网出口结果。');
            setStatus('webrtc-status', 'neutral', '未确认');
        }
    }

    const reachabilityTargets = [
        { id: 'reach-baidu', url: 'https://www.baidu.com/favicon.ico' },
        { id: 'reach-github', url: 'https://github.com/favicon.ico' },
        { id: 'reach-youtube', url: 'https://www.youtube.com/favicon.ico' }
    ];

    async function checkReachability(target, generation) {
        setStatus(`${target.id}-status`, 'loading', '检测中');
        setText(`${target.id}-detail`, '正在建立连接');
        try {
            await fetchWithTimeout(target.url, { mode: 'no-cors' }, REACHABILITY_TIMEOUT_MS);
            if (generation !== runGeneration) return;
            setStatus(`${target.id}-status`, 'success', '已响应');
            setText(`${target.id}-detail`, '浏览器请求已得到响应');
        } catch (error) {
            if (generation !== runGeneration) return;
            setStatus(`${target.id}-status`, 'neutral', '未确认');
            setText(`${target.id}-detail`, error && error.name === 'TimeoutError' ? '请求超时；可能受网络或代理规则影响' : '请求受阻或未得到响应，不能据此断定网站不可访问');
        }
    }

    function runAll() {
        runGeneration += 1;
        const generation = runGeneration;
        routeState.clear();
        loadRoute('route-cn', domesticSources, generation);
        loadRoute('route-global', globalSources, generation);
        loadProtocol('ipv4', 'https://api.ipify.org?format=json', 4, generation);
        loadProtocol('ipv6', 'https://api6.ipify.org?format=json', 6, generation);
        loadWebRtc(generation);
        reachabilityTargets.forEach((target) => checkReachability(target, generation));
    }

    function init() {
        const retryButton = $('retry-all');
        if (retryButton) retryButton.addEventListener('click', runAll);
        runAll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
