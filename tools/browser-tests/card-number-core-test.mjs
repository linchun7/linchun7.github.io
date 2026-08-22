import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const coreUrl = new URL('../card_number_new/core.js', import.meta.url);
const source = await readFile(coreUrl, 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: coreUrl.pathname });

const core = sandbox.CardNumberCore;
assert.ok(core, 'CardNumberCore failed to load');

function luhnValid(value) {
    const text = String(value);
    let sum = 0;
    for (let position = 0; position < text.length; position++) {
        let digit = Number(text[position]);
        if (((text.length - 1 - position) & 1) === 1) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
    }
    return sum % 10 === 0;
}

function compileVariables(pattern) {
    const variableIndex = new Map();
    const variableAtPosition = new Array(pattern.length).fill(-1);

    for (let position = 0; position < pattern.length; position++) {
        const char = pattern[position];
        if (/\d/.test(char)) continue;
        const key = char === '*' ? `star:${position}` : `letter:${char.toLowerCase()}`;
        if (!variableIndex.has(key)) variableIndex.set(key, variableIndex.size);
        variableAtPosition[position] = variableIndex.get(key);
    }

    return { variableAtPosition, variableCount: variableIndex.size };
}

function bruteForce(pattern, validDigits) {
    const { variableAtPosition, variableCount } = compileVariables(pattern);
    const assignment = new Array(variableCount);
    const results = [];

    function materialize() {
        let output = '';
        for (let position = 0; position < pattern.length; position++) {
            const variable = variableAtPosition[position];
            output += variable === -1 ? pattern[position] : assignment[variable];
        }
        return output;
    }

    function visit(index) {
        if (index === variableCount) {
            const value = materialize();
            if (luhnValid(value)) results.push(value);
            return;
        }
        for (const digit of validDigits) {
            assignment[index] = digit;
            visit(index + 1);
        }
    }

    visit(0);
    return results;
}

function runCore(pattern, validDigits) {
    const output = [];
    const result = core.calculate({
        input: pattern,
        validDigits,
        limit: 1_000_000,
        chunkSize: 37,
        onChunk(chunk) {
            output.push(...chunk);
        }
    });
    return { ...result, output };
}

function assertMatchesOracle(pattern, validDigits) {
    const expected = bruteForce(pattern, validDigits);
    const actual = runCore(pattern, validDigits);

    assert.equal(actual.expectedCount, String(expected.length), `Exact count mismatch for ${pattern} with [${validDigits}]`);
    assert.equal(actual.count, expected.length, `Retained count mismatch for ${pattern} with [${validDigits}]`);
    assert.equal(actual.truncated, false, `Unexpected truncation for ${pattern} with [${validDigits}]`);
    assert.deepEqual(actual.output, expected, `Generated results mismatch for ${pattern} with [${validDigits}]`);
}

assertMatchesOracle('7992739871*', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
assertMatchesOracle('12aa', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
assertMatchesOracle('12**', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
assertMatchesOracle('12aA*', [1, 3, 5, 7, 9]);
assertMatchesOracle('6214a*0a', [0, 2, 4, 6, 8]);
assertMatchesOracle('123456', [2, 7]);

let seed = 0x5eed1234;
function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
}

function randomInt(max) {
    return Math.floor(random() * max);
}

function variableCount(pattern) {
    return compileVariables(pattern).variableCount;
}

function randomPattern() {
    const length = 4 + randomInt(7);
    let pattern = '';

    for (let position = 0; position < length; position++) {
        const roll = random();
        let candidate;
        if (roll < 0.58) {
            candidate = String(randomInt(10));
        } else if (roll < 0.82) {
            candidate = random() < 0.5 ? 'a' : (random() < 0.5 ? 'A' : 'b');
        } else {
            candidate = '*';
        }

        const tentative = pattern + candidate;
        pattern += variableCount(tentative) <= 4 ? candidate : String(randomInt(10));
    }

    return pattern;
}

function randomValidDigits() {
    const digits = [];
    for (let digit = 0; digit <= 9; digit++) {
        if (random() >= 0.35) digits.push(digit);
    }
    if (digits.length === 0) digits.push(randomInt(10));
    return digits;
}

for (let caseIndex = 0; caseIndex < 160; caseIndex++) {
    assertMatchesOracle(randomPattern(), randomValidDigits());
}

console.log('Card number core oracle tests passed (160 deterministic randomized cases + fixed edge cases).');
