const ALLOWED_ORIGINS = new Set([
  'https://www.linchun.com.cn',
  'https://linchun.com.cn',
  'https://linchun7.github.io',
  'http://127.0.0.1:4173',
  'http://localhost:4173'
]);

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = new Headers({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Content-Type': 'application/json; charset=utf-8',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  });

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }

  return headers;
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request)
  });
}

function forbiddenOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin && !ALLOWED_ORIGINS.has(origin);
}

function ipFamily(ip) {
  if (!ip) return null;
  return ip.includes(':') ? 6 : 4;
}

function normalizeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function probePayload(request) {
  const cf = request.cf || {};
  const connectingIp = request.headers.get('CF-Connecting-IP') || '';
  const connectingIpv6 = request.headers.get('CF-Connecting-IPv6') || '';

  return {
    schemaVersion: 1,
    role: 'international-first-party',
    ip: connectingIp || null,
    family: ipFamily(connectingIp),
    originalIpv6: connectingIpv6 || null,
    network: {
      country: cf.country || null,
      region: cf.region || null,
      regionCode: cf.regionCode || null,
      city: cf.city || null,
      timezone: cf.timezone || null,
      asn: normalizeNumber(cf.asn),
      organization: cf.asOrganization || null,
      colo: cf.colo || null,
      tcpRttMs: normalizeNumber(cf.clientTcpRtt),
      quicRttMs: normalizeNumber(cf.clientQuicRtt)
    },
    observedAt: new Date().toISOString()
  };
}

export default {
  async fetch(request) {
    if (forbiddenOrigin(request)) {
      return json(request, { error: 'origin_not_allowed' }, 403);
    }

    if (request.method === 'OPTIONS') {
      const headers = corsHeaders(request);
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Accept');
      headers.set('Access-Control-Max-Age', '86400');
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(request, { error: 'method_not_allowed' }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      const response = json(request, { ok: true, service: 'linchun-myip-probe' });
      return request.method === 'HEAD'
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }

    if (url.pathname !== '/' && url.pathname !== '/v1/ip') {
      return json(request, { error: 'not_found' }, 404);
    }

    const payload = probePayload(request);
    if (!payload.ip) {
      return json(request, { error: 'client_ip_unavailable' }, 503);
    }

    const response = json(request, payload);
    return request.method === 'HEAD'
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }
};
