// Only the telemetry actually observed on the production deployment is exempt.
// Local/generated HTML remains strictly script-free. Unknown origins and paths
// must still fail the no-runtime-dependency regression.
export function isDeploymentTelemetryRequest(rawUrl, baseUrl, resourceType) {
  try {
    const base = new URL(baseUrl);
    const url = new URL(rawUrl, base);
    if (base.origin !== 'https://www.linchun.com.cn' || base.username || base.password ||
        url.username || url.password || url.hash || url.search) return false;
    if (resourceType === 'script') {
      return url.origin === 'https://static.cloudflareinsights.com' &&
        /^\/beacon\.min\.js(?:\/v[a-z0-9]+)?$/i.test(url.pathname);
    }
    return ['xhr', 'fetch'].includes(resourceType) &&
      url.origin === base.origin && url.pathname === '/cdn-cgi/rum';
  } catch {
    return false;
  }
}

export function isDeploymentTelemetryScript(script, baseUrl) {
  return script.beacon === true && script.text.trim() === '' &&
    isDeploymentTelemetryRequest(script.src, baseUrl, 'script');
}
