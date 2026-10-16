import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeploymentTelemetryRequest, isDeploymentTelemetryScript } from '../../browser-tests/translation-deployment-telemetry.mjs';

const production = 'https://www.linchun.com.cn';
const beacon = 'https://static.cloudflareinsights.com/beacon.min.js/v4bc70e2c01a94c73b74392e4234840661791215815920';

test('recognizes only the observed production beacon and same-origin RUM endpoint', () => {
  assert.equal(isDeploymentTelemetryRequest(beacon, production, 'script'), true);
  assert.equal(isDeploymentTelemetryRequest('https://static.cloudflareinsights.com/beacon.min.js', production, 'script'), true);
  for (const type of ['xhr', 'fetch']) {
    assert.equal(isDeploymentTelemetryRequest(production + '/cdn-cgi/rum?', production, type), true);
  }
  assert.equal(isDeploymentTelemetryScript({ src: beacon, text: '', beacon: true }, production), true);
});

test('never relaxes local or arbitrary deployment checks', () => {
  for (const base of ['http://127.0.0.1:4173', 'http://localhost:4173', 'https://preview.example', 'http://www.linchun.com.cn', 'https://www.linchun.com.cn.evil.test', 'https://u@www.linchun.com.cn', 'invalid']) {
    assert.equal(isDeploymentTelemetryRequest(beacon, base, 'script'), false, base);
    assert.equal(isDeploymentTelemetryRequest(production + '/cdn-cgi/rum', base, 'xhr'), false, base);
    assert.equal(isDeploymentTelemetryScript({ src: beacon, text: '', beacon: true }, base), false, base);
  }
});

test('rejects lookalike hosts, credentials, altered paths, inline bodies and application requests', () => {
  for (const url of [
    'http://static.cloudflareinsights.com/beacon.min.js',
    'https://static.cloudflareinsights.com.evil.test/beacon.min.js',
    'https://static.cloudflareinsights.com@evil.test/beacon.min.js',
    'https://u@static.cloudflareinsights.com/beacon.min.js',
    'https://static.cloudflareinsights.com:444/beacon.min.js',
    'https://static.cloudflareinsights.com/other.js',
    beacon + '/other.js', beacon + '?callback=run', beacon + '#run',
    production + '/tools/translation_benchmark/scripts/corpus.mjs',
    'data:text/javascript,alert(1)', 'javascript:alert(1)',
  ]) assert.equal(isDeploymentTelemetryRequest(url, production, 'script'), false, url);
  for (const url of [production + '/cdn-cgi/rum/extra', production + '/cdn-cgi/rum?callback=run', 'https://evil.test/cdn-cgi/rum', production + '/api/translate', production + '/tools/translation_benchmark/corpus.json']) {
    assert.equal(isDeploymentTelemetryRequest(url, production, 'fetch'), false, url);
  }
  assert.equal(isDeploymentTelemetryRequest(beacon, production, 'xhr'), false);
  assert.equal(isDeploymentTelemetryRequest(production + '/cdn-cgi/rum', production, 'script'), false);
  assert.equal(isDeploymentTelemetryScript({ src: beacon, text: 'alert(1)', beacon: true }, production), false);
  assert.equal(isDeploymentTelemetryScript({ src: beacon, text: '', beacon: false }, production), false);
  assert.equal(isDeploymentTelemetryScript({ src: '', text: 'alert(1)', beacon: true }, production), false);
});
