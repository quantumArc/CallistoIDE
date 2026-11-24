// Callisto Chess — UI controller
(function () {
  const Engine = window.ChessEngine;
  const AI = window.ChessAI;

  const PIECES = {
    w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
    b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
  };

  const state = {
    game: Engine.makeInitialState(),
    history: [],           // stack of {state, move, san} for undo
    selected: null,        // square index or null
    legalForSelected: [],  // moves from the selected square
    difficulty: 'medium',
    gameOver: false,
    lastMove: null         // {from, to}
  };

  let aiToken = 0; // incremented to cancel any pending AI move

  const els = {};

  function init() {
    els.board = document.getElementById('board');
    els.statusBar = document.getElementById('statusBar');
    els.moveList = document.getElementById('moveList');
    els.capturedByWhite = document.getElementById('capturedByWhite');
    els.capturedByBlack = document.getElementById('capturedByBlack');
    els.newGameBtn = document.getElementById('newGameBtn');
    els.undoBtn = document.getElementById('undoBtn');
    els.diffBtns = Array.from(document.querySelectorAll('.diff-btn'));

    els.newGameBtn.addEventListener('click', newGame);
    els.undoBtn.addEventListener('click', undoMove);
    els.diffBtns.forEach(btn => btn.addEventListener('click', () => setDifficulty(btn.dataset.diff)));

    render();
  }

  function newGame() {
    aiToken++; // cancel any pending AI move
    state.game = Engine.makeInitialState();
    state.history = [];
    state.selected = null;
    state.legalForSelected = [];
    state.gameOver = false;
    state.lastMove = null;
    render();
  }

  function setDifficulty(diff) {
    state.difficulty = diff;
    els.diffBtns.forEach(b => b.classList.toggle('active', b.dataset.diff === diff));
  }

  function render() {
    renderBoard();
    renderStatus();
    renderMoveList();
    renderCaptured();
    els.undoBtn.disabled = state.history.length === 0;
    }

  // a1 is dark: row+col even => dark
  function squareColor(sq) { return (Math.floor(sq / 8) + sq % 8) % 2 === 0 ? 'dark' : 'light'; }

  function renderBoard() {
    els.board.innerHTML = '';
    // White at bottom: rank 1 (row 0) is the bottom row of the grid, so iterate rows top-down from rank 8 to rank 1
    for (let displayRow = 7; displayRow >= 0; displayRow--) {
      for (let col = 0; col < 8; col++) {
        const sq = displayRow * 8 + col;
        const cell = document.createElement('div');
        cell.className = 'square ' + squareColor(sq);
        cell.dataset.sq = String(sq);
        cell.setAttribute('role', 'gridcell');

        const piece = state.game.board[sq];
        if (piece) {
          const span = document.createElement('span');
          span.className = 'piece piece-' + piece.color;
          span.textContent = PIECES[piece.color][piece.type];
          cell.appendChild(span);
        }

        // highlight last move
        if (state.lastMove && state.lastMove.from === sq) cell.classList.add('last-from');
        if (state.lastMove && state.lastMove.to === sq) cell.classList.add('last-to');

        // selection highlight
        if (state.selected === sq) cell.classList.add('selected');

        // legal move indicators
        const isLegalTarget = state.legalForSelected.some(m => m.to === sq);
        if (isLegalTarget) {
          const targetPiece = state.game.board[sq];
          cell.classList.add(targetPiece ? 'capture' : 'legal');
        }

        cell.addEventListener('click', () => onSquareClick(sq));
        els.board.appendChild(cell);
      }
    }
    renderRankLabels();
  }

  function renderRankLabels() {
    // Re-render coordinate labels cleanly: file letters on bottom row, rank numbers on left column
    const cells = els.board.querySelectorAll('.square');
    cells.forEach(cell => {
      cell.querySelectorAll('.coord').forEach(c => c.remove());
      const sq = Number(cell.dataset.sq);
      const row = Math.floor(sq / 8), col = sq % 8;
      if (row === 0 && col === 7) { // bottom-right square: show file letter
        const coord = document.createElement('span');
        coord.className = 'coord file';
        coord.textContent = Engine.FILES[col];
        cell.appendChild(coord);
      }
      if (col === 0 && row === 7) { // top-left square: show rank number
        const coord = document.createElement('span');
        coord.className = 'coord rank';
        coord.textContent = String(row + 1);
        cell.appendChild(coord);
      }
    });
  }

  function onSquareClick(sq) {
    if (state.gameOver) return;
    const piece = state.game.board[sq];

    // If a square is selected and this is a legal destination, make the move
    if (state.selected !== null && state.legalForSelected.some(m => m.to === sq)) {
      const promotionMoves = state.legalForSelected.filter(m => m.to === sq && m.promotion);
      const move = promotionMoves.find(m => m.promotion === 'q') || state.legalForSelected.find(m => m.to === sq);
      doMove(move);
      return;
    }

    // If clicking a friendly piece, select it and show legal moves
    if (piece && piece.color === 'w' && state.game.turn === 'w') {
      state.selected = sq;
      state.legalForSelected = Engine.legalMoves(state.game).filter(m => m.from === sq);
      render();
      return;
    }

    // Clicking elsewhere deselects
    if (state.selected !== null) {
      state.selected = null;
      state.legalForSelected = [];
      render();
    }
  }

  function doMove(move) {
    const san = Engine.moveToSan(state.game, move, Engine.legalMoves(state.game));
    state.history.push({ game: cloneState(state.game), move, san });
    state.lastMove = { from: move.from, to: move.to };
    state.selected = null;
    state.legalForSelected = [];
    state.game = Engine.applyMove(state.game, move);

    const status = Engine.gameStatus(state.game);
    if (status !== 'playing') {
      state.gameOver = true;
    }

    render();

    // If the game is not over and it's now black's turn, let the AI move
    if (!state.gameOver && state.game.turn === 'b') {
      const token = aiToken;
      setTimeout(() => { if (token === aiToken) aiMove(); }, 350);
    }
  }

  function aiMove() {
    const status = Engine.gameStatus(state.game);
    if (status !== 'playing' || state.game.turn !== 'b') return;
    const move = AI.pickMove(state.game, state.difficulty);
    if (!move) {
      state.gameOver = true;
      render();
      return;
    }
    doMove(move);
  }

  function undoMove() {
    aiToken++; // cancel any pending AI move
    const count = state.history.length >= 2 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const entry = state.history.pop();
      if (!entry) break;
      state.game = cloneState(entry.game); // restore to before that ply
    }
    const tail = state.history[state.history.length - 1];
    state.lastMove = tail ? { from: tail.move.from, to: tail.move.to } : null;
    state.selected = null;
    state.legalForSelected = [];
    state.gameOver = false;
    render(); // turn is always 'w' after undoing a full round — no AI re-move needed
  }

  function cloneState(s) {
    return {
      board: s.board.map(p => p ? { ...p } : null),
      turn: s.turn,
      castling: { ...s.castling },
      enPassant: s.enPassant,
      halfmove: s.halfmove,
      fullmove: s.fullmove
    };
  }

  function renderStatus() {
    const status = Engine.gameStatus(state.game);
    els.statusBar.classList.remove('check', 'gameover');
    if (status === 'checkmate') {
      const winner = state.game.turn === 'w' ? 'Black' : 'White';
      els.statusBar.textContent = `Checkmate — ${winner} wins!`;
      els.statusBar.classList.add('gameover');
    } else if (status === 'stalemate') {
      els.statusBar.textContent = 'Stalemate — draw';
      els.statusBar.classList.add('gameover');
    } else if (status === 'draw-insufficient' || status === 'draw-fifty') {
      els.statusBar.textContent = 'Draw — insufficient material / fifty-move rule';
      els.statusBar.classList.add('gameover');
    } else if (Engine.inCheck(state.game, state.game.turn)) {
      const who = state.game.turn === 'w' ? 'White' : 'Black';
      els.statusBar.textContent = `${who} is in check`;
      els.statusBar.classList.add('check');
    } else {
      const who = state.game.turn === 'w' ? 'White (you) to move' : 'AI thinking…';
      els.statusBar.textContent = who;
    }
  }

  function renderMoveList() {
    els.moveList.innerHTML = '';
    const pairs = [];
    for (let i = 0; i < state.history.length; i += 2) {
      pairs.push({ num: Math.floor(i / 2) + 1, w: state.history[i] ? state.history[i].san : '', b: state.history[i + 1] ? state.history[i + 1].san : '' });
    }
    pairs.forEach(p => {
      const li = document.createElement('li');
      const num = document.createElement('span'); num.className = 'num'; num.textContent = p.num + '.';
      const w = document.createElement('span'); w.className = 'w'; w.textContent = p.w;
      const b = document.createElement('span'); b.className = 'b'; b.textContent = p.b;
      li.appendChild(num); li.appendChild(w); li.appendChild(b);
      els.moveList.appendChild(li);
    });
    // scroll to bottom
    els.moveList.scrollTop = els.moveList.scrollHeight;
  }

  function renderCaptured() {
    const captured = Engine.capturedPieces(state.game);
    renderCapturedRow(els.capturedByWhite, 'You captured', captured.black, 'b'); // black pieces white took
    renderCapturedRow(els.capturedByBlack, 'AI captured', captured.white, 'w');  // white pieces black took
  }

  function renderCapturedRow(el, label, pieces, color) {
    el.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'captured-label';
    span.textContent = label + ':';
    el.appendChild(span);
    if (pieces.length === 0) {
      const empty = document.createElement('span');
      empty.style.color = '#475569';
      empty.textContent = '—';
      el.appendChild(empty);
      return;
    }
    for (const type of pieces) {
      const p = document.createElement('span');
      p.className = 'piece piece-' + color;
      p.textContent = PIECES[color][type] || '';
      el.appendChild(p);
    }
  }

  init();
})();
