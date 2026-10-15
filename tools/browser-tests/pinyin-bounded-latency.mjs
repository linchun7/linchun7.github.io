import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { chromium, firefox, webkit } from 'playwright';

// Bounded observation, not a device-independent performance budget.
// Runs only in GitHub Actions alongside the existing pinyin smoke test.
const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error('Unsupported browser: ' + browserName);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const repetitions = 3;
const browser = await browserType.launch({ headless: true });

const corpora = [
    {
        name: 'common-chinese-prose',
        text: '今天早上，我们沿着河边散步，看见公园里的花开了。回家以后，孩子读了一段关于春天的故事。下午要去银行办理业务，再和朋友讨论音乐、旅行以及重庆的美食。认真记录工作安排，及时检查结果，也给休息留出时间。'
    },
    {
        name: 'english-and-digits',
        text: 'Today we reviewed the project notes, planned a short walk, and checked the 2026 calendar. The next update is at 10:30; please keep the original text! '
    },
    {
        name: 'repeated-punctuation',
        text: '，。！？；：“”‘’（）【】、《》……——,.!?;:()[]{} <> \n\t'
    }
];
const sizes = [
    { length: 200, scope: 'everyday-short' },
    { length: 2000, scope: 'everyday-long' },
    { length: 10000, scope: 'extreme-bounded' },
    { length: 50000, scope: 'extreme-bounded' }
];
const fit = (text, length) => text.repeat(Math.ceil(length / text.length)).slice(0, length);
const emit = (kind, data) => console.log(kind + ' ' + JSON.stringify(data));

async function boundedEvaluate(page, fn, value) {
    let timer;
    try {
        // A test-harness watchdog, not an acceptance threshold for interaction speed.
        return await Promise.race([
            page.evaluate(fn, value),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Bounded pinyin evaluation exceeded the 60s harness watchdog')), 60000);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/googletagmanager.com/**', route => route.abort());
    await page.goto(baseUrl + '/tools/pinyin/', { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.pinyinPro?.pinyin));
    emit('PINYIN_ENVIRONMENT', {
        browser: browserName,
        browserVersion: browser.version(),
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpuCount: cpus().length,
        viewport: { width: 1280, height: 900 },
        headless: true,
        repetitions,
        units: 'milliseconds',
        measured: [
            'input event capture to synchronous output DOM completion',
            'input event capture to next queued timer task',
            'input event capture to next requestAnimationFrame callback (before paint)'
        ],
        excluded: [
            'page/library network loading',
            'textarea value assignment before the input event',
            'API oracle and assertions',
            'physical typing/paste delivery and actual pixel-paint completion'
        ],
        library: await page.locator('script[src*="pinyin-pro@"]').getAttribute('src')
    });

    // Keep the original API reference separate from app dispatch and call-count
    // instrumentation. Expected outputs are generated outside every timed span.
    await page.evaluate(() => {
        window.__pinyinOracle = window.pinyinPro.pinyin;
        window.__pinyinExpected = text => {
            const pinyin = window.__pinyinOracle;
            const trimmed = text.trim();
            const singleHan = Array.from(trimmed).length === 1 && /^\p{Script=Han}$/u.test(trimmed);
            const options = [
                { pattern: 'pinyin', nonZh: 'removed', toneType: 'none' },
                { pattern: 'pinyin', nonZh: 'removed', toneType: 'symbol' },
                { pattern: 'pinyin', nonZh: 'removed', toneType: 'num' },
                { pattern: 'first', toneType: 'none', nonZh: 'removed', separator: '' }
            ];
            const regular = text ? options.map(option => pinyin(text, option)) : ['', '', '', ''];
            const multiple = singleHan ? pinyin(trimmed, { multiple: true }) : '';
            const values = [...regular, multiple];
            const placeholders = text
                ? ['未识别到汉字', '未识别到汉字', '未识别到汉字', '未识别到汉字', singleHan ? '未识别到读音' : '仅单个汉字时显示']
                : ['等待输入', '等待输入', '等待输入', '等待输入', '仅单个汉字时显示'];
            return {
                text: values.map((value, i) => value || placeholders[i]),
                disabled: values.map(value => !value),
                callCount: text ? (singleHan ? 5 : 4) : 0,
                multiple
            };
        };
        window.__pinyinAssertOutputs = expected => {
            for (let i = 0; i < 5; i++) {
                const id = 'result' + (i + 1);
                const output = document.getElementById(id);
                const button = document.querySelector('[data-result="' + id + '"]');
                if (output.textContent !== expected.text[i]) throw new Error(id + ' differs from independent API oracle');
                if (button.disabled !== expected.disabled[i]) throw new Error(id + ' copy state differs from API oracle');
            }
        };
    });

    for (const text of ['', '汉语拼音', '行长', '重庆', '音乐', '吕布', '行', ' 重 ', '𠀀', 'A', '！？', '   ']) {
        const result = await boundedEvaluate(page, text => {
            const expected = window.__pinyinExpected(text);
            const original = window.pinyinPro.pinyin;
            const calls = [];
            window.pinyinPro.pinyin = (value, options) => {
                calls.push({ value, options });
                return original(value, options);
            };
            try {
                const input = document.getElementById('inputInfo');
                input.value = text;
                input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
                window.__pinyinAssertOutputs(expected);
                if (calls.length !== expected.callCount) throw new Error('Unexpected library call count: ' + calls.length);
                const multipleCalls = calls.filter(call => call.options?.multiple === true);
                if (multipleCalls.length !== (expected.callCount === 5 ? 1 : 0)) throw new Error('Unexpected single-Han multiple semantics');
                if (multipleCalls.length && multipleCalls[0].value !== text.trim()) throw new Error('Multiple API must receive the trimmed single Han character');
                return { text, callCount: calls.length, multiple: expected.multiple };
            } finally {
                window.pinyinPro.pinyin = original;
            }
        }, text);
        emit('PINYIN_SEMANTICS', { browser: browserName, ...result, oracleEquivalent: true });
    }

    // A single untimed warm-up per corpus. Every measured sample remains bounded
    // to a fixed input length and uses the unwrapped real pinyin-pro function.
    for (const corpus of corpora) {
        await boundedEvaluate(page, text => {
            const input = document.getElementById('inputInfo');
            input.value = text;
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
        }, fit(corpus.text, 200));
    }

    const metrics = [];
    for (const corpus of corpora) {
        for (const size of sizes) {
            const text = fit(corpus.text, size.length);
            for (let sample = 1; sample <= repetitions; sample++) {
                const observed = await boundedEvaluate(page, async text => {
                    const expected = window.__pinyinExpected(text);
                    const input = document.getElementById('inputInfo');
                    input.value = text;
                    // Allow oracle work and the preceding sample to leave the task.
                    await new Promise(resolve => setTimeout(resolve, 0));
                    return await new Promise((resolve, reject) => {
                        let started;
                        let outputDomMs;
                        let nextTaskMs;
                        let nextFrameMs;
                        const finish = () => {
                            if (nextTaskMs === undefined || nextFrameMs === undefined) return;
                            try {
                                window.__pinyinAssertOutputs(expected);
                                resolve({ outputDomMs, nextTaskMs, nextFrameMs, oracleEquivalent: true });
                            } catch (error) {
                                reject(error);
                            }
                        };
                        const start = () => { started = performance.now(); };
                        input.addEventListener('input', start, { capture: true, once: true });
                        // Schedule the responsiveness probe before dispatch so it
                        // waits behind the production synchronous input handler.
                        setTimeout(() => {
                            nextTaskMs = performance.now() - started;
                            finish();
                        }, 0);
                        requestAnimationFrame(() => {
                            nextFrameMs = performance.now() - started;
                            finish();
                        });
                        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
                        outputDomMs = performance.now() - started;
                    });
                }, text);
                for (const value of [observed.outputDomMs, observed.nextTaskMs, observed.nextFrameMs]) {
                    assert.ok(Number.isFinite(value) && value >= 0, 'finite non-negative latency measurement');
                }
                assert.ok(observed.nextTaskMs >= observed.outputDomMs, 'next timer task follows synchronous output completion');
                const result = {
                    browser: browserName,
                    corpus: corpus.name,
                    scope: size.scope,
                    utf16Length: text.length,
                    sample,
                    ...observed
                };
                metrics.push(result);
                emit('PINYIN_METRIC', result);
            }
        }
    }
    assert.deepEqual(errors, [], 'no unhandled page errors');
    const summaries = [];
    for (const corpus of corpora) {
        for (const size of sizes) {
            const rows = metrics.filter(row => row.corpus === corpus.name && row.utf16Length === size.length);
            const summary = { browser: browserName, corpus: corpus.name, scope: size.scope, utf16Length: size.length, samples: rows.length };
            for (const key of ['outputDomMs', 'nextTaskMs', 'nextFrameMs']) {
                const values = rows.map(row => row[key]).sort((a, b) => a - b);
                summary[key] = { min: values[0], median: values[1], max: values.at(-1) };
            }
            summaries.push(summary);
            emit('PINYIN_SUMMARY', summary);
        }
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY,
            '\n### Bounded pinyin latency: ' + browserName + '\n\n' +
            'Observations only; no cross-device speed threshold. All four normal outputs and the conditional single-Han fifth output matched the API oracle.\n\n' +
            'Durations in ms. DOM = input to output DOM completion; task = input to next queued timer callback; rAF = input to next pre-paint animation-frame callback.\n\n' +
            '| Corpus | Scope | UTF-16 length | DOM median (max) | Task median (max) | rAF median (max) |\n' +
            '| --- | --- | ---: | ---: | ---: | ---: |\n' +
            summaries.map(row => '| ' + [row.corpus, row.scope, row.utf16Length,
                ...['outputDomMs', 'nextTaskMs', 'nextFrameMs'].map(key =>
                    row[key].median.toFixed(2) + ' (' + row[key].max.toFixed(2) + ')')
            ].join(' | ') + ' |').join('\n') + '\n\n' +
            'Synthetic repeated prose/English/punctuation, warmed page, headless hosted Linux runner, 3 samples per cell. Excludes network and input delivery; rAF is not proof of pixel paint. See PINYIN_METRIC log lines for raw samples. This does not establish an unlimited-input exploit or a mandatory Worker threshold.\n');
    }
    emit('PINYIN_COMPLETE', { browser: browserName, measuredSamples: metrics.length, oracleEquivalent: true, performanceBudgetEnforced: false });
    await context.close();
} finally {
    await browser.close();
}
