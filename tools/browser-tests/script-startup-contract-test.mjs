import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// These pages expose editable controls at first paint. Their handlers and dependencies
// must not be postponed by Rocket Loader beyond the native DOMContentLoaded boundary.
const cases = [
  { tool: 'card_number', scripts: ['scripts.js?'] },
  { tool: 'card_number_new', scripts: ['core.js?', 'app.js?'] },
  { tool: 'financial_calculator', scripts: ['script.js?'] },
  { tool: 'renovation_calculator', scripts: ['script.js?'] },
  { tool: 'pinyin', scripts: ['https://cdn.jsdelivr.net/npm/pinyin-pro@', 'app.js?'] },
  { tool: 'space', scripts: ['dist/browser/pangu.min.js'], inline: "const textarea = document.getElementById('info')" },
  { tool: 'rmb_converter', scripts: ['dist/nzh.min.js'], inline: "const input = document.getElementById('inputmoney')" }
];
for (const entry of cases) {
  test(`${entry.tool} preserves native startup ordering`, async () => {
    const html = await readFile(new URL(`../${entry.tool}/index.html`, import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const source of entry.scripts) {
      const matching = scripts.filter(([, attrs]) => {
        const src = /\bsrc="([^"]+)"/.exec(attrs)?.[1];
        return src?.startsWith(source);
      });
      assert.equal(matching.length, 1, `${source}: exactly one source script`);
      assert.match(matching[0][1], /\bdata-cfasync="false"[\s\S]*\bsrc=/, `${source}: opt out before src`);
    }
    if (entry.inline) {
      const application = scripts.filter(([, , body]) => body.includes(entry.inline));
      assert.equal(application.length, 1);
      assert.match(application[0][1], /\bdata-cfasync="false"/, 'inline handler startup must not be delayed');
    }
  });
}

test('pinyin-pro is version-pinned and protected by SRI', async () => {
  const html = await readFile(new URL('../pinyin/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const dependency = scripts.filter(([, attrs]) => /\bsrc="https:\/\/cdn\.jsdelivr\.net\/npm\/pinyin-pro@/.test(attrs));
  assert.equal(dependency.length, 1, 'pinyin-pro: exactly one CDN dependency');
  const attrs = dependency[0][1];
  assert.match(attrs, /\bsrc="https:\/\/cdn\.jsdelivr\.net\/npm\/pinyin-pro@\d+\.\d+\.\d+\/dist\/index\.js"/);
  assert.match(attrs, /\bintegrity="sha384-[A-Za-z0-9+/]+={0,2}"/);
  assert.match(attrs, /\bcrossorigin="anonymous"/);
  assert.match(attrs, /\bdata-cfasync="false"[\s\S]*\bsrc=/);
});
