'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/todo.js');

test('add returns the new item with an id', () => {
    const store = createStore();
    assert.deepEqual(store.add('  buy milk '), { id: 1, text: 'buy milk', done: false });
    assert.equal(store.add('walk dog').id, 2);
});

test('add rejects empty text', () => {
    assert.throws(() => createStore().add('   '));
});

test('complete marks an item done', () => {
    const store = createStore();
    const { id } = store.add('write report');
    assert.equal(store.complete(id), true);
    assert.equal(store.list()[0].done, true);
    assert.equal(store.complete(99), false);
});
