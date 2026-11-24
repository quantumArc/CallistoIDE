'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeCircle, totalArea } = require('../src/report.js');

test('describeCircle', () => {
    assert.equal(describeCircle(1), 'circle of radius 1: area 3.14');
});

test('totalArea', () => {
    const total = totalArea([{ kind: 'circle', radius: 1 }, { kind: 'rectangle', width: 2, height: 3 }]);
    assert.ok(Math.abs(total - (Math.PI + 6)) < 1e-9);
});
