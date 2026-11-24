'use strict';

// Cases the model never sees: the fix must sort numerically, not just make the visible test pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mean, median, mode } = require(path.join(process.env.WORKSPACE, 'src', 'stats.js'));

test('median sorts numerically', () => {
    assert.equal(median([100, 9, 25, 1]), 17);
    assert.equal(median([-5, -10, 0]), -5);
    assert.equal(median([1000, 200, 30, 4, 5]), 30);
});

test('median leaves its input alone', () => {
    const values = [3, 1, 2];
    median(values);
    assert.deepEqual(values, [3, 1, 2]);
});

test('mean and mode still work', () => {
    assert.equal(mean([10, 20]), 15);
    assert.equal(mode([5, 5, 7, 7, 6]), 5);
});
