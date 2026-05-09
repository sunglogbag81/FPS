# Neon Arena FPS

A stable multiplayer browser FPS made with Three.js, Express, and Socket.IO.

## Features

- Pointer-lock first-person controls
- WASD movement, jump, sprint, mouse aim, click to shoot
- Multiplayer synchronization with Socket.IO
- Server-side player state, shooting validation, damage, kills, deaths, and respawn
- Deterministic arena map with collision obstacles
- HUD, hit feedback, kill feed, and leaderboard

## Run

```bash
npm install
npm start
```

Open <http://localhost:3000>.

## Controls

- `W A S D`: move
- `Shift`: sprint
- `Space`: jump
- Mouse: aim
- Left click: shoot
- `Esc`: unlock cursor / menu

## Notes

This version intentionally removes committed `node_modules` from the repository. Dependencies should be installed with `npm install`.
