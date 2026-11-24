'use strict';

function format(value) {
    return `[${value}]`;
}

function render(items) {
    return items.map(format).join('\n');
}

function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

module.exports = { format, render, slugify };
