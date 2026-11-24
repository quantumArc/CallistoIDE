// Pure-JS chess engine (no dependencies).
// Board layout: index = row * 8 + col, row 0 = rank 1 (white home), col 0 = file a.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChessEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FILES = 'abcdefgh';

  function squareName(sq) { return FILES[sq % 8] + (Math.floor(sq / 8) + 1); }

  function makeInitialState() {
    const board = new Array(64).fill(null);
    const backRank = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    for (let c = 0; c < 8; c++) {
      board[c] = { type: backRank[c], color: 'w' };       // rank 1
      board[8 + c] = { type: 'p', color: 'w' };            // rank 2
      board[48 + c] = { type: 'p', color: 'b' };           // rank 7
      board[56 + c] = { type: backRank[c], color: 'b' };   // rank 8
    }
    return {
      board,
      turn: 'w',
      castling: { K: true, Q: true, k: true, q: true },
      enPassant: null,
      halfmove: 0,
      fullmove: 1
    };
  }

  function isAttacked(board, sq, byColor) {
    const col = sq % 8, row = Math.floor(sq / 8);
    // pawns (a white pawn attacks from one rank below the target square)
    if (byColor === 'w') {
      for (const dc of [-1, 1]) {
        const c = col + dc, r = row - 1;
        if (r >= 0 && c >= 0 && c < 8) {
          const p = board[r * 8 + c];
          if (p && p.type === 'p' && p.color === 'w') return true;
        }
      }
    } else {
      for (const dc of [-1, 1]) {
        const c = col + dc, r = row + 1;
        if (r < 8 && c >= 0 && c < 8) {
          const p = board[r * 8 + c];
          if (p && p.type === 'p' && p.color === 'b') return true;
        }
      }
    }
    // knights
    for (const [dr, dc] of [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]]) {
      const r = row + dr, c = col + dc;
      if (r >= 0 && r < 8 && c >= 0 && c < 8) {
        const p = board[r * 8 + c];
        if (p && p.type === 'n' && p.color === byColor) return true;
      }
    }
    // king
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = row + dr, c = col + dc;
        if (r >= 0 && r < 8 && c >= 0 && c < 8) {
          const p = board[r * 8 + c];
          if (p && p.type === 'k' && p.color === byColor) return true;
        }
      }
    }
    // diagonals: bishop / queen
    for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      let r = row + dr, c = col + dc;
      while (r >= 0 && r < 8 && c >= 0 && c < 8) {
        const p = board[r * 8 + c];
        if (p) {
          if (p.color === byColor && (p.type === 'b' || p.type === 'q')) return true;
          break;
        }
        r += dr; c += dc;
      }
    }
    // straight lines: rook / queen
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let r = row + dr, c = col + dc;
      while (r >= 0 && r < 8 && c >= 0 && c < 8) {
        const p = board[r * 8 + c];
        if (p) {
          if (p.color === byColor && (p.type === 'r' || p.type === 'q')) return true;
          break;
        }
        r += dr; c += dc;
      }
    }
    return false;
  }

  function addPawnMoves(moves, state, from, to, color) {
    const row = Math.floor(to / 8);
    const promoRow = color === 'w' ? 7 : 0;
    if (row === promoRow) {
      for (const promotion of ['q', 'r', 'b', 'n']) {
        moves.push({ from, to, piece: 'p', color, promotion });
      }
    } else {
      moves.push({ from, to, piece: 'p', color });
    }
  }

  function generatePseudoLegal(state, color) {
    const board = state.board;
    const moves = [];
    for (let sq = 0; sq < 64; sq++) {
      const p = board[sq];
      if (!p || p.color !== color) continue;
      const col = sq % 8, row = Math.floor(sq / 8);

      if (p.type === 'p') {
        const dir = color === 'w' ? 1 : -1;
        const startRow = color === 'w' ? 1 : 6;
        const oneStep = sq + dir * 8;
        if (row + dir >= 0 && row + dir < 8) {
          if (!board[oneStep]) {
            addPawnMoves(moves, state, sq, oneStep, color);
            const twoStep = sq + dir * 16;
            if (row === startRow && !board[twoStep]) {
              moves.push({ from: sq, to: twoStep, piece: 'p', color, isDoublePush: true });
            }
          }
          for (const dc of [-1, 1]) {
            const c = col + dc, r = row + dir;
            if (c < 0 || c > 7 || r < 0 || r > 7) continue;
            const target = r * 8 + c;
            const t = board[target];
            if (t && t.color !== color) {
              addPawnMoves(moves, state, sq, target, color);
            } else if (!t && state.enPassant === target) {
              moves.push({ from: sq, to: target, piece: 'p', color, isEnPassant: true });
            }
          }
        }
      } else if (p.type === 'n') {
        for (const [dr, dc] of [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]]) {
          const r = row + dr, c = col + dc;
          if (r < 0 || r > 7 || c < 0 || c > 7) continue;
          const target = r * 8 + c;
          const t = board[target];
          if (!t || t.color !== color) moves.push({ from: sq, to: target, piece: 'n', color });
        }
      } else if (p.type === 'k') {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const r = row + dr, c = col + dc;
            if (r < 0 || r > 7 || c < 0 || c > 7) continue;
            const target = r * 8 + c;
            const t = board[target];
            if (!t || t.color !== color) moves.push({ from: sq, to: target, piece: 'k', color });
          }
        }
        // castling
        const rights = state.castling;
        if (color === 'w' && sq === 4) {
          if (rights.K && !board[5] && !board[6] && board[7] && board[7].type === 'r' && board[7].color === 'w') {
            if (!isAttacked(board, 4, 'b') && !isAttacked(board, 5, 'b') && !isAttacked(board, 6, 'b')) {
              moves.push({ from: 4, to: 6, piece: 'k', color, castle: 'K' });
            }
          }
          if (rights.Q && !board[3] && !board[2] && !board[1] && board[0] && board[0].type === 'r' && board[0].color === 'w') {
            if (!isAttacked(board, 4, 'b') && !isAttacked(board, 3, 'b') && !isAttacked(board, 2, 'b')) {
              moves.push({ from: 4, to: 2, piece: 'k', color, castle: 'Q' });
            }
          }
        } else if (color === 'b' && sq === 60) {
          if (rights.k && !board[61] && !board[62] && board[63] && board[63].type === 'r' && board[63].color === 'b') {
            if (!isAttacked(board, 60, 'w') && !isAttacked(board, 61, 'w') && !isAttacked(board, 62, 'w')) {
              moves.push({ from: 60, to: 62, piece: 'k', color, castle: 'k' });
            }
          }
          if (rights.q && !board[59] && !board[58] && !board[57] && board[56] && board[56].type === 'r' && board[56].color === 'b') {
            if (!isAttacked(board, 60, 'w') && !isAttacked(board, 59, 'w') && !isAttacked(board, 58, 'w')) {
              moves.push({ from: 60, to: 58, piece: 'k', color, castle: 'q' });
            }
          }
        }
      } else if (p.type === 'b' || p.type === 'r' || p.type === 'q') {
        const dirs = [];
        if (p.type === 'b' || p.type === 'q') dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
        if (p.type === 'r' || p.type === 'q') dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
        for (const [dr, dc] of dirs) {
          let r = row + dr, c = col + dc;
          while (r >= 0 && r < 8 && c >= 0 && c < 8) {
            const target = r * 8 + c;
            const t = board[target];
            if (!t) {
              moves.push({ from: sq, to: target, piece: p.type, color });
            } else {
              if (t.color !== color) moves.push({ from: sq, to: target, piece: p.type, color });
              break;
            }
            r += dr; c += dc;
          }
        }
      }
    }
    return moves;
  }

  function applyMove(state, move) {
    const board = state.board.slice();
    const piece = board[move.from];
    if (!piece) throw new Error('applyMove: no piece at from square');

    // en passant capture removes the pawn behind the destination
    if (move.isEnPassant) {
      const fromRow = Math.floor(move.from / 8);
      board[fromRow * 8 + (move.to % 8)] = null;
    }

    // castling moves the rook too
    if (move.castle === 'K') { board[5] = board[7]; board[7] = null; }
    else if (move.castle === 'Q') { board[3] = board[0]; board[0] = null; }
    else if (move.castle === 'k') { board[61] = board[63]; board[63] = null; }
    else if (move.castle === 'q') { board[59] = board[56]; board[56] = null; }

    board[move.to] = move.promotion ? { type: move.promotion, color: piece.color } : piece;
    board[move.from] = null;

    const castling = { ...state.castling };
    if (piece.type === 'k') {
      if (piece.color === 'w') { castling.K = false; castling.Q = false; }
      else { castling.k = false; castling.q = false; }
    }
    const homeRookRight = { 7: 'K', 0: 'Q', 63: 'k', 56: 'q' };
    if (homeRookRight[move.from] !== undefined) castling[homeRookRight[move.from]] = false;
    const capturedHomeRook = homeRookRight[move.to];
    if (capturedHomeRook !== undefined && state.board[move.to]) castling[capturedHomeRook] = false;

    let enPassant = null;
    if (move.isDoublePush) {
      const dir = piece.color === 'w' ? 1 : -1;
      enPassant = move.from + dir * 8;
    }

    const isCapture = !!state.board[move.to] || move.isEnPassant;
    const halfmove = (piece.type === 'p' || isCapture) ? 0 : state.halfmove + 1;
    const fullmove = state.fullmove + (state.turn === 'b' ? 1 : 0);

    return {
      board,
      turn: state.turn === 'w' ? 'b' : 'w',
      castling,
      enPassant,
      halfmove,
      fullmove
    };
  }

  function legalMoves(state) {
    const color = state.turn;
    const pseudo = generatePseudoLegal(state, color);
    return pseudo.filter(m => {
      const next = applyMove(state, m);
      for (let sq = 0; sq < 64; sq++) {
        const p = next.board[sq];
        if (p && p.type === 'k' && p.color === color) {
          return !isAttacked(next.board, sq, color === 'w' ? 'b' : 'w');
        }
      }
      return false;
    });
  }

  function inCheck(state, color) {
    for (let sq = 0; sq < 64; sq++) {
      const p = state.board[sq];
      if (p && p.type === 'k' && p.color === color) {
        return isAttacked(state.board, sq, color === 'w' ? 'b' : 'w');
      }
    }
    return false;
  }

  function gameStatus(state) {
    const moves = legalMoves(state);
    if (moves.length === 0) {
      return inCheck(state, state.turn) ? 'checkmate' : 'stalemate';
    }
    let nonKingPieces = [];
    for (const p of state.board) if (p && p.type !== 'k') nonKingPieces.push(p);
    const hasPawnOrMajor = nonKingPieces.some(p => p.type === 'p' || p.type === 'r' || p.type === 'q');
    if (!hasPawnOrMajor && nonKingPieces.length <= 1) return 'draw-insufficient';
    if (state.halfmove >= 100) return 'draw-fifty';
    return 'playing';
  }

  function moveToSan(state, move, legalList) {
    const p = state.board[move.from];
    if (!p) return '';
    const isCapture = !!state.board[move.to] || move.isEnPassant;
    let san;
    if (move.castle === 'K' || move.castle === 'k') {
      san = 'O-O';
    } else if (move.castle === 'Q' || move.castle === 'q') {
      san = 'O-O-O';
    } else if (p.type === 'p') {
      san = '';
      if (isCapture) san += FILES[move.from % 8] + 'x';
      san += squareName(move.to);
      if (move.promotion) san += '=' + move.promotion.toUpperCase();
    } else {
      san = p.type.toUpperCase();
      const others = legalList ? legalList.filter(m => m.piece === p.type && m.from !== move.from && m.to === move.to) : [];
      if (others.length > 0) {
        const sameFile = others.some(m => (m.from % 8) === (move.from % 8));
        const sameRank = others.some(m => Math.floor(m.from / 8) === Math.floor(move.from / 8));
        if (!sameFile) san += FILES[move.from % 8];
        else if (!sameRank) san += String(Math.floor(move.from / 8) + 1);
        else san += squareName(move.from);
      }
      if (isCapture) san += 'x';
      san += squareName(move.to);
    }
    const next = applyMove(state, move);
    if (inCheck(next, next.turn)) {
      san += legalMoves(next).length === 0 ? '#' : '+';
    }
    return san;
  }

  function capturedPieces(state) {
    // returns { white: [pieces black has captured], black: [pieces white has captured] }
    const initial = makeInitialState().board;
    const counts = {};
    for (const p of state.board) {
      if (!p || p.type === 'k') continue;
      const key = p.color + ':' + p.type;
      counts[key] = (counts[key] || 0) + 1;
    }
    const initialCounts = {};
    for (const p of initial) {
      if (!p || p.type === 'k') continue;
      const key = p.color + ':' + p.type;
      initialCounts[key] = (initialCounts[key] || 0) + 1;
    }
    // promotions complicate this slightly, but for casual play it is fine to report net captures
    const whiteCapturedByBlack = [];
    const blackCapturedByWhite = [];
    for (const key of Object.keys(initialCounts)) {
      const [color, type] = key.split(':');
      const missing = initialCounts[key] - (counts[key] || 0);
      // promotions can make a piece appear that was not in the initial set; ignore those by only counting deficits of original types
      for (let i = 0; i < Math.max(0, missing); i++) {
        if (color === 'w') whiteCapturedByBlack.push(type);
        else blackCapturedByWhite.push(type);
      }
    }
    return { white: whiteCapturedByBlack, black: blackCapturedByWhite };
  }

  return {
    FILES,
    squareName,
    makeInitialState,
    isAttacked,
    generatePseudoLegal,
    applyMove,
    legalMoves,
    inCheck,
    gameStatus,
    moveToSan,
    capturedPieces
  };
});
