import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStaticPageMatches, renderStaticFragments, replaceStaticFragments } from './static-page.mjs';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function seoProjection(payload) {
  const tiers = payload.tiers.map(({ id }) => id).join('、');
  return {
    description: `比较 Apple iCloud+ 全球各国家和地区价格，涵盖日本、美国、俄罗斯、土耳其、尼日利亚等热门市场，覆盖 ${tiers} 月费，并提供当地币价、人民币参考价、最低价排名和价格历史。`,
    imageAlt: `iCloud+ 全球价格对比：${tiers}`,
    brandDescription: `覆盖 Apple iCloud+ ${tiers} 套餐，比较全球各地区当地月费与人民币参考价。`
  };
}

function replaceExactlyOnce(html, pattern, replacement, label) {
  const matches = [...html.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`SEO_PROJECTION_TARGET_INVALID:${label}:${matches.length}`);
  return html.replace(pattern, replacement);
}

export function renderSeoProjection(html, payload) {
  const { description, imageAlt, brandDescription } = seoProjection(payload);
  const escapedDescription = escapeHtmlAttribute(description);
  const escapedImageAlt = escapeHtmlAttribute(imageAlt);
  let rendered = html;
  rendered = replaceExactlyOnce(rendered, /<meta name="description" content="[^"]*">/g,
    `<meta name="description" content="${escapedDescription}">`, 'description');
  rendered = replaceExactlyOnce(rendered, /<meta property="og:description" content="[^"]*">/g,
    `<meta property="og:description" content="${escapedDescription}">`, 'og-description');
  rendered = replaceExactlyOnce(rendered, /<meta property="og:image:alt" content="[^"]*">/g,
    `<meta property="og:image:alt" content="${escapedImageAlt}">`, 'og-image-alt');
  rendered = replaceExactlyOnce(rendered, /<meta name="twitter:description" content="[^"]*">/g,
    `<meta name="twitter:description" content="${escapedDescription}">`, 'twitter-description');
  rendered = replaceExactlyOnce(rendered, /<meta name="twitter:image:alt" content="[^"]*">/g,
    `<meta name="twitter:image:alt" content="${escapedImageAlt}">`, 'twitter-image-alt');
  rendered = replaceExactlyOnce(
    rendered,
    /(<div class="brand-copy">\s*<h1>iCloud\+ 全球价格对比<\/h1>\s*)<p(?: id="brandDescription")?>[^<]*<\/p>/g,
    `$1<p id="brandDescription">${brandDescription}</p>`,
    'brand-description'
  );
  return rendered;
}

export function assertSeoProjectionMatches(html, payload) {
  if (renderSeoProjection(html, payload) !== html) throw new Error('SEO_PROJECTION_MISMATCH');
  return true;
}

export async function renderStaticPage({
  write = false,
  indexPath = path.join(projectDirectory, 'index.html'),
  pricesPath = path.join(projectDirectory, 'data/prices.json')
} = {}) {
  const [html, payloadText] = await Promise.all([readFile(indexPath, 'utf8'), readFile(pricesPath, 'utf8')]);
  const payload = JSON.parse(payloadText);
  if (!write) {
    assertStaticPageMatches(html, payload);
    assertSeoProjectionMatches(html, payload);
    return { changed: false, bytes: Buffer.byteLength(html), countries: payload.countries.length, tiers: payload.tiers.length };
  }
  const rendered = renderSeoProjection(replaceStaticFragments(html, renderStaticFragments(payload)), payload);
  if (rendered !== html) await writeFile(indexPath, rendered, 'utf8');
  assertStaticPageMatches(rendered, payload);
  assertSeoProjectionMatches(rendered, payload);
  return { changed: rendered !== html, bytes: Buffer.byteLength(rendered), countries: payload.countries.length, tiers: payload.tiers.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (!['--write', '--check'].includes(mode)) throw new Error('Usage: node scripts/render-static-page.mjs (--write | --check)');
  const valueFor = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const result = await renderStaticPage({
    write: mode === '--write',
    indexPath: valueFor('--index-file') ?? path.join(projectDirectory, 'index.html'),
    pricesPath: valueFor('--prices-file') ?? path.join(projectDirectory, 'data/prices.json')
  });
  console.log(`Static iCloud page ${mode === '--write' ? 'rendered' : 'verified'}: ${JSON.stringify(result)}`);
}
