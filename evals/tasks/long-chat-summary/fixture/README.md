# ♞ Callisto Chess

A zero-dependency chess app where you play against an AI opponent. Pure HTML/CSS/JS — no build step, no dependencies.

## How to run

Open `index.html` in any modern browser (double-click it, or serve the folder with any static server):

```bash
# Option A: just open the file
open index.html        # macOS
start index.html       # Windows

# Option B: serve locally (recommended for best experience)
python3 -m http.server 8080
# then visit http://localhost:8080
```

## How to play

- You are always **White**; the AI plays Black.
- Click a piece, then click its destination square (legal moves show as dots / capture rings).
- Pick a difficulty in the sidebar: **Easy** (random with slight capture bias), **Medium** (minimax depth 2), **Hard** (minimax depth 3 with alpha-beta pruning and piece-square tables).
- Use **New Game** to start over, or **Undo Move** to take back your last turn (and the AI's reply).
- The move list shows SAN notation; captured pieces are shown in the sidebar.

## Project structure

```
index.html     — page layout and script tags
style.css      — dark theme, board grid, highlights
app.js         — UI controller: rendering, click handling, game state, AI scheduling
js/engine.js   — pure-JS chess engine (move generation, legality, SAN, status)
js/ai.js       — minimax + alpha-beta pruning with difficulty levels
```

## Notes / limitations

- Promotions auto-select the queen variant in the UI (the engine supports all four promotion pieces).
- The captured-pieces panel is approximate: it counts deficit of original piece types, so promoted pieces may not be tracked perfectly.
- Threefold repetition and fifty-move rule are approximated via halfmove counter; threefold repetition is not detected.
