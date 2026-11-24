'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mean, median, mode } = require('../src/stats.js');

test('mean', () => {
    assert.equal(mean([1, 2, 3, 4]), 2.5);
});

test('median of an odd count', () => {
    assert.equal(median([3, 1, 2]), 2);
});

test('median of an even count', () => {
    assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('median with multi-digit numbers', () => {
    assert.equal(median([3, 10, 2]), 3);
});

test('mode prefers the smallest of equally frequent values', () => {
    assert.equal(mode([3, 3, 1, 1, 2]), 1);
});
