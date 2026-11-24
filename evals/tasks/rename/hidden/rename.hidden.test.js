'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const geometry = require(path.join(process.env.WORKSPACE, 'src', 'geometry.js'));
const report = require(path.join(process.env.WORKSPACE, 'src', 'report.js'));

test('circleArea is exported and areaOfCircle is gone', () => {
    assert.equal(typeof geometry.circleArea, 'function');
    assert.equal(geometry.areaOfCircle, undefined);
    assert.ok(Math.abs(geometry.circleArea(2) - 4 * Math.PI) < 1e-9);
});

test('callers still work', () => {
    assert.equal(report.describeCircle(2), 'circle of radius 2: area 12.57');
    assert.ok(Math.abs(report.totalArea([{ kind: 'circle', radius: 2 }]) - 4 * Math.PI) < 1e-9);
});
