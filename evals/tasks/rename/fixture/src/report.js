'use strict';

const { areaOfCircle, rectangleArea } = require('./geometry.js');

function describeCircle(radius) {
    return `circle of radius ${radius}: area ${areaOfCircle(radius).toFixed(2)}`;
}

function describeRectangle(width, height) {
    return `rectangle ${width}x${height}: area ${rectangleArea(width, height).toFixed(2)}`;
}

function totalArea(shapes) {
    return shapes.reduce((sum, shape) => sum + (shape.kind === 'circle'
        ? areaOfCircle(shape.radius)
        : rectangleArea(shape.width, shape.height)), 0);
}

module.exports = { describeCircle, describeRectangle, totalArea };
