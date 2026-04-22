# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow

After completing any meaningful unit of work, commit and push to GitHub. Don't batch up large changes — commit incrementally so progress is never lost.

- Stage specific files rather than `git add .`
- Write clear, descriptive commit messages that explain *what changed and why*
- Push to the remote after each commit: `git push`

## Running the Games

Both games are static HTML files with no build step or dependencies — open them directly in a browser:

- **Tic Tac Toe**: open `tictactoe.html`
- **Dead Zone shooter**: open `shooter/index.html`

A quick way to serve them locally:

```sh
python3 -m http.server 8080
```

Then navigate to `http://localhost:8080`.

## Architecture

### tictactoe.html
Single self-contained file. All styles, markup, and logic are inline. Game state is three variables (`board`, `current`, `over`) plus a `scores` object. No external dependencies.

### shooter/ (Dead Zone)
A top-down retro shooter split into three files:

- `index.html` — minimal shell; mounts the `<canvas>` and a CRT overlay `<div>`
- `style.css` — centers the canvas, applies `image-rendering: pixelated`, and adds a CRT scanline + vignette effect via CSS
- `game.js` — all game logic (~736 lines), structured as:
  - **Constants** (`ENEMY_CFG`, speeds, timings) at the top
  - **Global mutable state** (game state machine, entity arrays, input maps)
  - **Factory functions** (`makePlayer`, `makeEnemy`, `makeParticle`, `makePopup`)
  - **Lifecycle functions** (`startGame`, `beginLevel`) that reset/initialize state
  - **Update functions** (`update`, `updatePlayer`, `updateEnemies`, `updateBullets`, `updateParticles`, `updateSpawner`) called each frame
  - **Draw functions** (`draw`, `drawPlayer`, `drawEnemy`, `drawWalkerBody`/`drawRunnerBody`/`drawTankBody`, `drawBullets`, `drawParticles`, `drawHUD`, overlay screens) all using raw Canvas 2D API
  - **Game loop** via `requestAnimationFrame`; `dt` is capped at 50ms to prevent spiral-of-death on tab blur

**State machine**: `STATES = { MENU, PLAYING, LEVEL_COMPLETE, GAME_OVER }`. The `update()` function branches on `gameState` first; `draw()` does the same.

**Enemy system**: Three types (`walker`, `runner`, `tank`) configured in `ENEMY_CFG`. Enemies are queued per-level via `buildQueue()` (shuffled array) and trickle-spawned by `updateSpawner`. Each enemy wanders slightly off the direct pursuit angle using a periodic `wanderOffset`.

**High score** persisted to `localStorage` under the key `dz_hi`.
