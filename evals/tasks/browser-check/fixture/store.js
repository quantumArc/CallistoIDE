const todos = [];

export function addTodo(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return false;
    }
    todos.push({ text: trimmed, done: false });
    return true;
}

export function toggleTodo(index) {
    todos[index].done = !todos[index].done;
}

export function allTodos() {
    return todos;
}

export function countRemaining() {
    return todos.filter(todo => !todo.done).length;
}
