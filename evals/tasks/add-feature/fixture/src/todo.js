'use strict';

/** An in-memory todo list. Items are copied on the way out, so callers cannot change the store by accident. */
function createStore() {
    const items = [];
    let nextId = 1;
    return {
        add(text) {
            if (typeof text !== 'string' || text.trim() === '') {
                throw new Error('text must be a non-empty string');
            }
            const item = { id: nextId++, text: text.trim(), done: false };
            items.push(item);
            return { ...item };
        },
        complete(id) {
            const item = items.find(candidate => candidate.id === id);
            if (!item) {
                return false;
            }
            item.done = true;
            return true;
        },
        list() {
            return items.map(item => ({ ...item }));
        }
    };
}

module.exports = { createStore };
