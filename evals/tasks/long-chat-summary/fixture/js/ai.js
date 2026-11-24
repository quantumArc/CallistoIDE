// Minimax AI with alpha-beta pruning and difficulty levels.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChessAI = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const Engine = (typeof require !== 'undefined') ? require('./engine.js') : (typeof self !== 'undefined' ? self.ChessEngine : null);

  const VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

  // Simple piece-square tables (white perspective). Indexed by square 0..63.
  const PST = {
    p: [
      0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
      5,  5, 10, 25, 25, 10, 5,  5,
      0,  0,  0, 20, 20, 0,  0,  0,
      5, -5,-10,  0,  0,-10, -5,  5,
      5, 10, 10,-20,-20, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0
    ],
    n: [
       -50,-40,-30,-30,-30,-30,-40,-50,
      -40,-20,  0,  0,  0,  0,-20,-40,
      -30,  0, 10, 15, 15, 10,  0,-30,
      -30,  5, 15, 20, 20, 15,  5,-30,
      -30,  0, 15, 20, 20, 15,  0,-30,
      -30,  5, 10, 15, 15, 10,  5,-30,
      -40,-20,  0,  5,  5,  0,-20,-40,
      -50,-40,-30,-30,-30,-30,-40,-50
    ],
    b: [
       -20,-10,-10,-10,-10,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5, 10, 10,  5,  0,-10,
      -10,  5,  5, 10, 10,  5,  5,-10,
      -10,  0, 10, 10, 10, 10,  0,-10,
      -10, 10, 10, 10, 10, 10, 10,-10,
      -10,  5,  0,  0,  0,  0,  5,-10,
      -20,-10,-10,-10,-10,-10,-10,-20
    ],
    r: [
         0,  0,  0,  0,  0,  0,  0,  0,
        10, 15, 15, 15, 15, 15, 15, 10,
        -5,  0,  0,  0,  0,  0,  0, -5,
        -5,  0,  0,  0,  0,  0,  0, -5,
        -5,  0,  0,  0,  0,  0,  0, -5,
        -5,  0,  0,  0,  0,  0,  0, -5,
        -5,  0,  0,  0,  0,  0,  0, -5,
         0,  0,  0,  5,  5,  0,  0,  0
    ],
    q: [
       -20,-10,-10, -5, -5,-10,-10,-20,
        -10,  0,  0,  0,  0,  0,  0,-10,
        -10,  0,  5,  5,  5,  5,  0,-10,
         -5,  0,  5,  5,  5,  5,  0, -5,
          0,  0,  5,  5,  5,  5,  0, -5,
        -10,  5,  5,  5,  5,  5,  0,-10,
        -10,  0,  5,  0,  0,  0,  0,-10,
        -20,-10,-10, -5, -5,-10,-10,-20
    ],
    k: [
         20, 30, 10,  0,  0, 10, 30, 20,
         20, 20,  0,  0,  0,  0, 20, 20,
         10, 10,-10,-20,-20,-10, 10, 10,
          0,  0,-20,-30,-30,-20,  0,  0,
        -10,-10,-20,-30,-30,-20,-10,-10,
        -20,-20,-20,-20,-20,-20,-20,-20,
        -30,-30,-30,-30,-30,-30,-30,-30,
        -50,-40,-30,-30,-30,-30,-40,-50
    ]
  };

  function mirror(sq) { return (7 - Math.floor(sq / 8)) * 8 + (sq % 8); }

  // Evaluate position from the perspective of `aiColor`. Positive = good for AI.
  function evaluateForColor(state, aiColor) {
    let score = 0;
    for (let sq = 0; sq < 64; sq++) {
      const p = state.board[sq];
      if (!p || p.type === 'k') continue;
      const sign = p.color === aiColor ? 1 : -1;
      score += sign * VALUES[p.type];
      const sqForPST = p.color === 'w' ? sq : mirror(sq);
      score += sign * PST[p.type][sqForPST];
    }
    return score;
  }

  function minimaxFromColor(state, depth, aiColor, alpha, beta) {
    const status = Engine.gameStatus(state);
    if (status === 'checkmate' || status === 'stalemate' || depth <= 0) {
      // checkmate: the side to move is mated — bad for that side
      if (status === 'checkmate') {
        return state.turn === aiColor ? -100000 : 100000;
      }
      return evaluateForColor(state, aiColor); // stalemate or depth limit
    }
    const moves = Engine.legalMoves(state);
    if (moves.length === 0) {
      return state.turn === aiColor ? -100000 : 100000;
    }
    const maximizing = state.turn === aiColor;
    let best = maximizing ? -Infinity : Infinity;
    for (const m of moves) {
      const next = Engine.applyMove(state, m);
      const score = minimaxFromColor(next, depth - 1, aiColor, alpha, beta);
      if (maximizing) {
        best = Math.max(best, score);
        alpha = Math.max(alpha, best);
      } else {
        best = Math.min(best, score);
        beta = Math.min(beta, best);
      }
      if (beta <= alpha) break; // alpha-beta cutoff
    }
    return best;
  }

  function findBestMove(state, depth, aiColor) {
    const moves = Engine.legalMoves(state);
    if (moves.length === 0) return null;
    let bestScore = -Infinity;
    let bestMoves = [];
    for (const m of moves) {
      const next = Engine.applyMove(state, m);
      const score = minimaxFromColor(next, depth - 1, aiColor, -Infinity, Infinity);
      if (score > bestScore) {
        bestScore = score;
        bestMoves = [m];
      } else if (score === bestScore) {
        bestMoves.push(m);
      }
    }
    return bestMoves[Math.floor(Math.random() * bestMoves.length)];
  }

  function pickMove(state, difficulty) {
    const moves = Engine.legalMoves(state);
    if (moves.length === 0) return null;
    if (difficulty === 'easy') {
      // random move with slight preference for captures and checks
      const weighted = [];
      for (const m of moves) {
        let w = 1;
        const target = state.board[m.to];
        if (target && target.color !== state.turn) w += VALUES[target.type] / 100;
        weighted.push({ m, w });
      }
      let total = weighted.reduce((s, x) => s + x.w, 0);
      let r = Math.random() * total;
      for (const { m, w } of weighted) {
        r -= w;
        if (r <= 0) return m;
      }
      return moves[moves.length - 1];
    }
    const depth = difficulty === 'medium' ? 2 : 3;
    return findBestMove(state, depth, state.turn);
  }

  return { pickMove, evaluateForColor: (s, c) => evaluateForColor(s, c), VALUES };
});
