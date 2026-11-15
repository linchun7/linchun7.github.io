import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { loadManifest, verifyUi } from './space-production.mjs';

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const manifest = loadManifest(sha);
const files = new Map(await Promise.all([
    'tools/space/index.html', ...manifest.resources.map(resource => resource.path)
].map(async path => ['/' + path, await readFile(new URL('../../' + path, import.meta.url))])));

async function fixture(fault, check) {
    let injected = 0;
    const timers = new Set();
    const server = createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const path = url.pathname === '/tools/space/' ? '/tools/space/index.html' : url.pathname;
        const body = files.get(path);
        if (!body) { response.writeHead(404); response.end(); return; }
        const mime = path.endsWith('.html') ? 'text/html' : 'text/javascript';
        if (fault && path === '/' + fault.path) {
            injected += 1;
            if (fault.mode === 'mime') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(body); return; }
            if (fault.mode === 'hash') { response.writeHead(200, { 'content-type': mime }); response.end(Buffer.concat([body, Buffer.from('\n/* wrong bytes */')])); return; }
            if (fault.mode === 'http') { response.writeHead(503, { 'content-type': mime }); response.end(body); return; }
            if (fault.mode === 'interrupt') {
                response.writeHead(200, { 'content-type': mime, 'content-length': body.length });
                response.write(body.subarray(0, Math.max(1, Math.floor(body.length / 2))));
                response.destroy();
                return;
            }
            if (fault.mode === 'delay') {
                const timer = setTimeout(() => { timers.delete(timer); response.writeHead(200, { 'content-type': mime }); response.end(body); }, 12000);
                timers.add(timer);
                return;
            }
        }
        response.writeHead(200, { 'content-type': mime });
        response.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await check('http://127.0.0.1:' + server.address().port + '/tools/space/');
        if (fault) assert.ok(injected > 0, 'negative case must reach the actual dependency request');
    } finally {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

test('real Worker chain: exact-byte and native-network positive controls', { timeout: 60000 }, async () => {
    await fixture(null, baseUrl => verifyUi(manifest, { baseUrl }));
});

for (const resource of manifest.resources) {
    for (const mode of ['mime', 'hash', 'http', 'interrupt', 'delay']) {
        test('real Worker chain rejects ' + mode + ' for ' + resource.path, { timeout: 20000 }, async () => {
            await fixture({ path: resource.path, mode }, async baseUrl => {
                await assert.rejects(verifyUi(manifest, { baseUrl, timeoutMs: 6000 }));
            });
        });
    }
}
