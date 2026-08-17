(() => {
    'use strict';

    const REQUEST_TIMEOUT_MS = 7000;
    const WEBRTC_TIMEOUT_MS = 5000;
    const REACHABILITY_TIMEOUT_MS = 6000;

    const providerResults = new Map();

    const $ = (id) => document.getElementById(id);

    function normalizeText(value) {
        if (value === null || value === undefined) return '';
        return String(value).trim();
    }

    function joinText(values) {
        return values.map(normalizeText).filter(Boolean).join(' ');
    }

    function isIpAddress(value) {
        const text = normalizeText(value);
        if (!text) return false;

        const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
        if (ipv4.test(text)) return true;

        // Browsers may expose compressed IPv6 forms (for example 2001:db8::1).
        // A lightweight shape check is sufficient here because the value is display-only
        // and still comes from a trusted JSON field/candidate parser before textContent rendering.
        const ipv6 = text.split('%')[0];
        return ipv6.includes(':') && ipv6.length <= 45 && /^[0-9a-f:.]+$/i.test(ipv6);
    }

    function createTimeoutError(label) {
        const error = new Error(`${label || '请求'}超时`);
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

            if (response.type !== 'opaque' && !response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return response;
        } catch (error) {
            if (error && error.name === 'AbortError') {
                throw createTimeoutError();
            }
            throw error;
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    async function fetchJson(url) {
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            mode: 'cors',
            headers: { Accept: 'application/json' }
        });
        return response.json();
    }

    function setText(id, value) {
        const element = $(id);
        if (!element) return;
        element.textContent = normalizeText(value);
    }

    function setStatus(id, state, text) {
        const element = $(id);
        if (!element) return;
        element.className = `status-pill status-${state}`;
        element.textContent = text;
    }

    function setProviderLoading(id) {
        providerResults.delete(id);
        setText(`${id}-ip`, '查询中…');
        setText(`${id}-detail`, '正在连接数据源');
        setStatus(`${id}-status`, 'loading', '查询中');
    }

    function setProviderSuccess(id, result) {
        const ip = normalizeText(result.ip);
        const detail = normalizeText(result.detail) || '已获取公网地址';
        providerResults.set(id, { ip, detail });
        setText(`${id}-ip`, ip || '未返回 IP');
        setText(`${id}-detail`, detail);
        setStatus(`${id}-status`, 'success', '正常');
        updateSummary();
    }

    function setProviderError(id, error) {
        providerResults.delete(id);
        setText(`${id}-ip`, '暂不可用');
        setText(`${id}-detail`, error instanceof Error ? error.message : '请求失败');
        setStatus(`${id}-status`, 'error', '失败');
        updateSummary();
    }

    function uniqueIps() {
        return [...new Set(
            [...providerResults.values()]
                .map((item) => normalizeText(item.ip))
                .filter(isIpAddress)
        )];
    }

    function updateSummary() {
        const ips = uniqueIps();
        const summaryIp = $('summary-ip');
        const summaryDetail = $('summary-detail');
        const summaryStatus = $('summary-status');

        if (!summaryIp || !summaryDetail || !summaryStatus) return;

        if (ips.length === 0) {
            summaryIp.textContent = '正在获取公网 IP…';
            summaryDetail.textContent = '各数据源会独立重试，单个服务失败不会影响其他结果。';
            summaryStatus.className = 'status-pill status-loading';
            summaryStatus.textContent = '查询中';
            return;
        }

        if (ips.length === 1) {
            summaryIp.textContent = ips[0];
            summaryDetail.textContent = providerResults.size >= 2
                ? `已有 ${providerResults.size} 个数据源返回结果。`
                : '已获取公网出口地址，其他数据源仍在查询。';
            summaryStatus.className = 'status-pill status-success';
            summaryStatus.textContent = '已获取';
            return;
        }

        summaryIp.textContent = ips.join(' / ');
        summaryDetail.textContent = '不同服务返回了不同出口 IP，常见于 IPv4/IPv6 双栈、代理、VPN 或 iCloud Private Relay。';
        summaryStatus.className = 'status-pill status-warning';
        summaryStatus.textContent = '多出口';
    }

    const providers = [
        {
            id: 'provider-baidu',
            async load() {
                const data = await fetchJson('https://qifu-api.baidubce.com/ip/local/geo/v1/district');
                if (!data || !isIpAddress(data.ip)) throw new Error('百度接口未返回有效 IP');
                return {
                    ip: data.ip,
                    detail: joinText([
                        data.data && data.data.country,
                        data.data && data.data.prov,
                        data.data && data.data.city,
                        data.data && data.data.district,
                        data.data && data.data.isp
                    ])
                };
            }
        },
        {
            id: 'provider-ipsb',
            async load() {
                const data = await fetchJson('https://api.ip.sb/geoip');
                if (!data || !isIpAddress(data.ip)) throw new Error('IP.SB 未返回有效 IP');
                return {
                    ip: data.ip,
                    detail: joinText([data.country, data.city, data.organization])
                };
            }
        },
        {
            id: 'provider-ipify',
            async load() {
                const data = await fetchJson('https://api64.ipify.org?format=json');
                if (!data || !isIpAddress(data.ip)) throw new Error('IPify 未返回有效 IP');

                let detail = 'IPify 公网地址';
                try {
                    const geo = await fetchJson(`https://ipapi.co/${encodeURIComponent(data.ip)}/json/`);
                    detail = joinText([geo.country_name, geo.region, geo.city, geo.org]) || detail;
                } catch (error) {
                    console.warn('IPify 地理信息查询失败：', error);
                }

                return { ip: data.ip, detail };
            }
        }
    ];

    async function loadProvider(provider) {
        setProviderLoading(provider.id);
        try {
            const result = await provider.load();
            setProviderSuccess(provider.id, result);
        } catch (error) {
            console.warn(`${provider.id} 查询失败：`, error);
            setProviderError(provider.id, error);
        }
    }

    function getCandidateAddress(candidate) {
        if (!candidate) return '';

        if (candidate.address) {
            return normalizeText(candidate.address);
        }

        const raw = normalizeText(candidate.candidate);
        const parts = raw.split(/\s+/);
        return parts.length >= 6 ? normalizeText(parts[4]) : '';
    }

    async function collectWebRtcCandidates() {
        const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (typeof PeerConnection !== 'function') {
            return {
                state: 'unsupported',
                title: '浏览器未提供 WebRTC',
                detail: '公网 IP 查询不受影响。'
            };
        }

        let pc;
        const found = new Map();
        let sawMdns = false;

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

                    if (isIpAddress(address)) {
                        found.set(`${type}:${address}`, { type, address });
                    }
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
        if (candidates.length > 0) {
            const summary = candidates
                .slice(0, 4)
                .map((item) => `${item.type}: ${item.address}`)
                .join(' · ');
            return {
                state: 'success',
                title: summary,
                detail: sawMdns
                    ? '同时检测到 mDNS 隐私候选；浏览器可能隐藏真实局域网地址。'
                    : 'WebRTC 候选仅用于网络诊断，不作为公网 IP 的唯一判断依据。'
            };
        }

        if (sawMdns) {
            return {
                state: 'privacy',
                title: '本地地址已被浏览器隐藏',
                detail: '检测到 mDNS 候选。这是 Safari/WebKit 等现代浏览器的正常隐私保护。'
            };
        }

        return {
            state: 'privacy',
            title: '浏览器未暴露网络候选',
            detail: '可能由浏览器隐私策略、Private Relay、VPN 或 STUN 网络限制导致；公网 IP 查询仍可正常使用。'
        };
    }

    async function loadWebRtc() {
        setText('webrtc-ip', '检测中…');
        setText('webrtc-detail', 'WebRTC 仅作为辅助诊断，不影响公网 IP 查询。');
        setStatus('webrtc-status', 'loading', '检测中');

        try {
            const result = await collectWebRtcCandidates();
            setText('webrtc-ip', result.title);
            setText('webrtc-detail', result.detail);

            if (result.state === 'success') {
                setStatus('webrtc-status', 'success', '已检测');
            } else if (result.state === 'unsupported') {
                setStatus('webrtc-status', 'warning', '不支持');
            } else {
                setStatus('webrtc-status', 'warning', '隐私保护');
            }
        } catch (error) {
            console.warn('WebRTC 检测失败：', error);
            setText('webrtc-ip', 'WebRTC 检测不可用');
            setText('webrtc-detail', error instanceof Error ? error.message : '检测失败');
            setStatus('webrtc-status', 'error', '失败');
        }
    }

    const reachabilityTargets = [
        { id: 'reach-baidu', url: 'https://www.baidu.com/favicon.ico' },
        { id: 'reach-netease', url: 'https://music.163.com/favicon.ico' },
        { id: 'reach-github', url: 'https://github.com/favicon.ico' },
        { id: 'reach-youtube', url: 'https://www.youtube.com/favicon.ico' }
    ];

    async function checkReachability(target) {
        setStatus(`${target.id}-status`, 'loading', '检测中');
        setText(`${target.id}-detail`, '正在建立连接');

        try {
            await fetchWithTimeout(target.url, { method: 'GET', mode: 'no-cors' }, REACHABILITY_TIMEOUT_MS);
            setStatus(`${target.id}-status`, 'success', '可连接');
            setText(`${target.id}-detail`, '浏览器能够发起网络请求');
        } catch (error) {
            setStatus(`${target.id}-status`, 'error', '不可达');
            setText(
                `${target.id}-detail`,
                error && error.name === 'TimeoutError' ? '连接超时' : '请求被阻断或网络不可达'
            );
        }
    }

    function runAll() {
        providerResults.clear();
        updateSummary();

        providers.forEach((provider) => {
            loadProvider(provider);
        });

        loadWebRtc();

        reachabilityTargets.forEach((target) => {
            checkReachability(target);
        });
    }

    function init() {
        const retryButton = $('retry-all');
        if (retryButton) {
            retryButton.addEventListener('click', runAll);
        }

        runAll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();