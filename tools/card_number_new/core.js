(function (global) {
    'use strict';

    const LUHN_TABLE = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [0, 2, 4, 6, 8, 1, 3, 5, 7, 9]
    ];

    function formatIntegerString(value) {
        if (value === null || value === undefined) return '—';
        return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function normalizeRuleInput(value, maxLength = 100) {
        const raw = String(value ?? '');
        let normalized = raw;
        try {
            normalized = raw.normalize('NFKC');
        } catch (error) {
            normalized = raw;
        }

        const removedChars = [];
        let output = '';
        let symbolCount = 0;
        let truncated = false;

        for (const char of normalized) {
            if (/[a-zA-Z0-9*]/.test(char)) {
                if (symbolCount >= maxLength) {
                    truncated = true;
                    continue;
                }
                output += char;
                symbolCount++;
                continue;
            }

            if (/\s/.test(char)) {
                if (output && !output.endsWith(' ') && symbolCount < maxLength) output += ' ';
                continue;
            }

            removedChars.push(char);
        }

        return {
            value: output.trimEnd(),
            removedChars: Array.from(new Set(removedChars)),
            truncated,
            normalizedChanged: normalized !== raw,
            symbolCount
        };
    }

    function compile(pattern, validDigits) {
        const variableIndex = new Map();
        const tokens = [];
        const contributions = [];
        let fixedContribution = 0;

        for (let position = 0; position < pattern.length; position++) {
            const char = pattern[position];
            const parity = (pattern.length - 1 - position) & 1;

            if (char >= '0' && char <= '9') {
                const digit = char.charCodeAt(0) - 48;
                fixedContribution = (fixedContribution + LUHN_TABLE[parity][digit]) % 10;
                tokens.push({ digit: char });
                continue;
            }

            const key = char === '*' ? `star:${position}` : `letter:${char.toLowerCase()}`;
            let index = variableIndex.get(key);
            if (index === undefined) {
                index = contributions.length;
                variableIndex.set(key, index);
                contributions.push(new Array(10).fill(0));
            }

            for (let digit = 0; digit <= 9; digit++) {
                contributions[index][digit] = (contributions[index][digit] + LUHN_TABLE[parity][digit]) % 10;
            }
            tokens.push({ variable: index });
        }

        const suffixCounts = Array.from({ length: contributions.length + 1 }, () => new Array(10).fill(0n));
        suffixCounts[contributions.length][0] = 1n;

        for (let index = contributions.length - 1; index >= 0; index--) {
            for (const digit of validDigits) {
                const ownContribution = contributions[index][digit];
                for (let residue = 0; residue < 10; residue++) {
                    const count = suffixCounts[index + 1][residue];
                    if (count > 0n) {
                        suffixCounts[index][(ownContribution + residue) % 10] += count;
                    }
                }
            }
        }

        return { tokens, contributions, suffixCounts, fixedContribution };
    }

    function materialize(tokens, assignment) {
        const output = new Array(tokens.length);
        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];
            output[index] = token.digit === undefined ? assignment[token.variable] : token.digit;
        }
        return output.join('');
    }

    function calculate(options) {
        const {
            input,
            validDigits,
            limit,
            chunkSize = 2000,
            onMeta = () => {},
            onChunk = () => {}
        } = options;

        const compiled = compile(input, validDigits);
        const variableCount = compiled.contributions.length;
        const requiredResidue = (10 - compiled.fixedContribution) % 10;
        const exactCount = compiled.suffixCounts[0][requiredResidue];
        const assignment = new Array(variableCount);
        let chunk = [];
        let retainedCount = 0;

        onMeta(exactCount.toString());

        function flush() {
            if (chunk.length === 0) return;
            onChunk(chunk, retainedCount);
            chunk = [];
        }

        function generate(index, residue) {
            if (retainedCount >= limit) return;

            if (index === variableCount) {
                if ((compiled.fixedContribution + residue) % 10 === 0) {
                    chunk.push(materialize(compiled.tokens, assignment));
                    retainedCount++;
                    if (chunk.length >= chunkSize) flush();
                }
                return;
            }

            for (const digit of validDigits) {
                if (retainedCount >= limit) break;
                const nextResidue = (residue + compiled.contributions[index][digit]) % 10;
                const suffixNeeded = (10 - ((compiled.fixedContribution + nextResidue) % 10)) % 10;
                if (compiled.suffixCounts[index + 1][suffixNeeded] === 0n) continue;
                assignment[index] = digit;
                generate(index + 1, nextResidue);
            }
        }

        generate(0, 0);
        flush();

        return {
            expectedCount: exactCount.toString(),
            count: retainedCount,
            truncated: exactCount > BigInt(retainedCount)
        };
    }

    function luhnValid(value) {
        const text = String(value);
        if (!/^\d+$/.test(text)) return false;
        let sum = 0;
        for (let position = 0; position < text.length; position++) {
            const digit = text.charCodeAt(position) - 48;
            const parity = (text.length - 1 - position) & 1;
            sum += LUHN_TABLE[parity][digit];
        }
        return sum % 10 === 0;
    }

    function hasDifferentDigits(value) {
        for (let index = 1; index < value.length; index++) {
            if (value[index] !== value[0]) return true;
        }
        return false;
    }

    function isPalindrome(value) {
        for (let left = 0, right = value.length - 1; left < right; left++, right--) {
            if (value[left] !== value[right]) return false;
        }
        return true;
    }

    function analyzeCardFeatures(cardNumber) {
        const features = [];
        const length = cardNumber.length;

        let repeatLength = 1;
        while (repeatLength < length && cardNumber[length - 1 - repeatLength] === cardNumber[length - 1]) {
            repeatLength++;
        }
        if (repeatLength >= 4) {
            features.push({ type: 'repeat', label: `${repeatLength}连`, title: `末尾 ${repeatLength} 位数字相同` });
        }

        if (length >= 4) {
            const direction = cardNumber.charCodeAt(length - 1) - cardNumber.charCodeAt(length - 2);
            if (direction === 1 || direction === -1) {
                let sequenceLength = 2;
                while (
                    sequenceLength < length &&
                    cardNumber.charCodeAt(length - sequenceLength) - cardNumber.charCodeAt(length - sequenceLength - 1) === direction
                ) {
                    sequenceLength++;
                }
                if (sequenceLength >= 4) {
                    const ascending = direction === 1;
                    features.push({
                        type: ascending ? 'sequence-up' : 'sequence-down',
                        label: `${sequenceLength}${ascending ? '顺' : '倒顺'}`,
                        title: `末尾 ${sequenceLength} 位数字${ascending ? '连续递增' : '连续递减'}`
                    });
                }
            }
        }

        let palindromeLength = 0;
        for (let size = Math.min(8, length); size >= 4; size--) {
            const tail = cardNumber.slice(-size);
            if (hasDifferentDigits(tail) && isPalindrome(tail)) {
                palindromeLength = size;
                features.push({ type: 'palindrome', label: `${size}位回文`, title: `末尾 ${size} 位正读与反读相同` });
                break;
            }
        }

        let cycleType = '';
        if (length >= 8) {
            const tail8 = cardNumber.slice(-8);
            if (tail8.slice(0, 4) === tail8.slice(4) && hasDifferentDigits(tail8.slice(0, 4))) {
                cycleType = 'ABCDABCD';
            }
        }
        if (!cycleType && length >= 6) {
            const tail6 = cardNumber.slice(-6);
            if (tail6.slice(0, 3) === tail6.slice(3) && hasDifferentDigits(tail6.slice(0, 3))) {
                cycleType = 'ABCABC';
            }
        }
        if (cycleType) {
            features.push({ type: 'cycle', label: cycleType, title: '末尾数字按相同组合循环' });
        }

        if (!palindromeLength && !cycleType && length >= 4) {
            const tail4 = cardNumber.slice(-4);
            const [a, b, c, d] = tail4;
            if (a === b && c === d && a !== c) {
                features.push({ type: 'aabb', label: 'AABB', title: '末尾为两组不同的重复数字' });
            } else if (a === c && b === d && a !== b) {
                features.push({ type: 'abab', label: 'ABAB', title: '末尾为两组交替数字' });
            }
        }

        return features;
    }

    function getFeatureLabels(features) {
        return features.map((feature) => feature.label);
    }

    global.CardNumberCore = {
        analyzeCardFeatures,
        calculate,
        compile,
        formatIntegerString,
        getFeatureLabels,
        luhnValid,
        normalizeRuleInput
    };
})(typeof self !== 'undefined' ? self : globalThis);
