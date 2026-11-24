'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');

const file = path.join(process.env.WORKSPACE, 'wordfreq.js');
const { topWords } = require(file);

test('counts lower-cased words and breaks ties alphabetically', () => {
    assert.deepEqual(topWords('The cat and the hat. THE end', 2), [['the', 3], ['and', 1]]);
});

test('keeps apostrophes inside words and ignores digits and punctuation', () => {
    assert.deepEqual(topWords("Don't stop -- don't 42 stop, DON'T!", 2), [["don't", 3], ['stop', 2]]);
});

test('returns every word when n is larger than the number of words', () => {
    assert.deepEqual(topWords('b a b', 10), [['b', 2], ['a', 1]]);
});

test('command line prints `word count` lines', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wordfreq-'));
    const input = path.join(dir, 'input.txt');
    writeFileSync(input, 'zeta alpha zeta beta alpha zeta');
    const output = execFileSync(process.execPath, [file, input, '2'], { encoding: 'utf8' });
    assert.deepEqual(output.trim().split('\n').map(line => line.trim()), ['zeta 3', 'alpha 2']);
});
