'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { areaOfCircle, rectangleArea } = require('../src/geometry.js');

test('areaOfCircle', () => {
    assert.ok(Math.abs(areaOfCircle(1) - Math.PI) < 1e-9);
});

test('rectangleArea', () => {
    assert.equal(rectangleArea(2, 3), 6);
});
