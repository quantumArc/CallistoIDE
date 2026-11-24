'use strict';

function parse(input) {
    return String(input).trim().split(/\s+/);
}

function format(tokens) {
    return tokens.join(' ');
}

function validate(tokens) {
    return Array.isArray(tokens) && tokens.every(token => token.length > 0);
}

module.exports = { parse, format, validate };
