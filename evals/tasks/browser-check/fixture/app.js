import { addTodo, allTodos, remaining, toggleTodo } from './store.js';

const form = document.getElementById('add-form');
const input = document.getElementById('new-todo');
const list = document.getElementById('todo-list');
const count = document.getElementById('count');

function render() {
    list.innerHTML = '';
    allTodos().forEach((todo, index) => {
        const item = document.createElement('li');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = todo.done;
        box.addEventListener('change', () => {
            toggleTodo(index);
            render();
        });
        const label = document.createElement('span');
        label.textContent = todo.text;
        if (todo.done) {
            item.classList.add('done');
        }
        item.append(box, label);
        list.append(item);
    });
    const left = remaining();
    count.textContent = `${left} ${left === 1 ? 'item' : 'items'} left`;
}

form.addEventListener('submit', () => {
    if (addTodo(input.value)) {
        input.value = '';
        render();
    }
});

render();
