'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createStore } = require(path.join(process.env.WORKSPACE, 'src', 'todo.js'));

test('remove deletes the item and returns true', () => {
    const store = createStore();
    store.add('a');
    const { id } = store.add('b');
    store.add('c');
    assert.equal(store.remove(id), true);
    assert.deepEqual(store.list().map(item => item.text), ['a', 'c']);
});

test('remove returns false for an unknown or already removed id', () => {
    const store = createStore();
    const { id } = store.add('a');
    assert.equal(store.remove(42), false);
    assert.equal(store.remove(id), true);
    assert.equal(store.remove(id), false);
    assert.deepEqual(store.list(), []);
});

test('ids are not reused after a removal', () => {
    const store = createStore();
    const first = store.add('a');
    store.remove(first.id);
    assert.notEqual(store.add('b').id, first.id);
});
