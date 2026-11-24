'use strict';

// Internal helper: not exported.
function parse(raw) {
    return JSON.parse(raw);
}

function validate(config) {
    return typeof config === 'object' && config !== null;
}

function render(config) {
    return Object.entries(config).map(([key, value]) => `${key}=${value}`).join('\n');
}

function load(raw) {
    const config = parse(raw);
    if (!validate(config)) {
        throw new Error('bad config');
    }
    return config;
}

module.exports = { validate, render, load };
