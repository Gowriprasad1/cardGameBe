# Backend (Phase 4): how it works and how to run it

Node.js 20+, Express 5, Socket.IO 4, `pg` for PostgreSQL (Neon). Plain JavaScript with JSDoc. Runtime dependencies are only `express`, `socket.io` and `pg`. Dev dependencies: `socket.io-client` and `@electric-sql/pglite` (an in-process Postgres used by the tests).

## Run it

```bash
cd backend
npm install
export DATABASE_URL='postgres://USER:PASSWORD@HOST/DB?sslmode=require'   # your Neon connection string
export CLIENT_ORIGIN='http://localhost:4200'                              # comma separated allow-list
npm run migrate        # applies db/migrations/*.sql (safe to repeat)
npm start
npm test               # unit + integration, no database needed
```

`AUTO_MIGRATE=true` runs the migrations at startup (convenient on Render).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none, required | Neon connection string. Never commit it. |
| `CLIENT_ORIGIN` | `http://localhost:4200` | Allowed browser origins for REST and Socket.IO (comma separated, no trailing slash). |
| `PORT` | `3000` | Render sets this itself. |
| `NODE_ENV` | `development` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |
| `AUTO_MIGRATE` | `false` | Run migrations at startup. |
| `TURN_TIMER_SECONDS` | `60` | Per-turn limit. `0` turns the timer off. |
| `RECONNECT_GRACE_SECONDS` | `90` | With the turn timer off, how long a disconnected player's turn waits before the server plays it. |
| `ROUND_BREAK_SECONDS` | `10` | Pause on the round result before the next deal. Skipped when every connected player sends `next-round-ready`. |
| `ROOM_IDLE_MINUTES` | `30` | A room nobody is connected to for this long is abandoned. |
| `RATE_LIMIT_API` / `RATE_LIMIT_STRICT` | `120` / `20` | REST requests per minute per address (strict applies to guest creation and room lookup). |

## Layers

```
src/
  server.js              builds the container, REST app and Socket.IO, handles shutdown
  app.js                 REST routes (thin controllers)
  socket/index.js        Socket.IO handlers: auth, rate limit, validate, call one service, ack
  middleware/http.js     request id, security headers, CORS allow-list, rate limit, auth, error handler
  validators/            payload schemas (no dependency)
  constants/errors.js    AppError + public error catalogue
  config/                env + structured logger (secrets and cards are redacted)
  platform/
    room.service.js            rooms, membership, presence, recovery, idle sweep
    game-session.service.js    runs live games: queue, idempotency, persist, publish, timers
    game-persistence.service.js  every DB write for a game, one transaction each
    user.service.js            guest identity (token hashed with SHA-256)
    game-registry.js           game code -> game module
    container.js               wiring
  db/                    pool wrapper, migration runner, repositories (parameterised SQL only)
  games/set/             the pure SET engine from Phase 3
```

The platform talks to a game only through `createGame`, `applyAction`, `viewFor` and `nextTimer`.

## How one action flows

1. The socket handler checks the token (done at connection), the per-socket rate limit and the payload schema. The player is the authenticated user and the room is the one the server has on record for that user, never values from the payload.
2. `GameSessionService.perform` runs it inside the room's queue, so simultaneous actions are applied strictly one after another.
3. A repeated `requestId` returns the earlier outcome (`duplicate: true`) and changes nothing. A unique key on `game_actions` backs this up across restarts.
4. The engine applies the action in memory without side effects.
5. `GamePersistence.saveAction` writes the action, the snapshot and anything it caused (new round, finished round and scores, finished game) in ONE transaction.
6. Only after that succeeds is the new state swapped in and events published. If the database write fails the old state stays, so memory and the database never disagree about an accepted action.
7. Events go to the room or to one user. Every player also gets their own `game-state` view.

## What is stored and when

| Moment | Written |
|---|---|
| Action accepted | `game_actions` row, session snapshot and version |
| Round dealt | `game_rounds`, `round_players`, all `card_decks`, hands in `player_cards` |
| Round finished | round result, `round_players`, `player_scores` (unique per round and player), cumulative scores, eliminations, final card positions |
| Game finished | session and room closed, `game_history` |

During a round the session snapshot is the recoverable copy of the piles and hands. `card_decks`/`player_cards` are written at the deal and again at the end of the round.

## Reconnection and restarts

- **Reconnect:** a socket that connects with a valid token is put back into its room's channel automatically. The client then calls `resume` to get the room and its private game view. Other players see `player-disconnected` and `player-reconnected`.
- **Disconnected player's turn:** with the turn timer on it runs as normal. With it off, the server plays the turn after `RECONNECT_GRACE_SECONDS`. Repeated timeouts drop the player (3 by default).
- **Server restart (Render redeploy or crash):** on startup the backend reloads waiting rooms and in-progress games from PostgreSQL and rearms the turn timers. Clients reconnect and call `resume`. Tested.
- **Render free tier:** instances sleep after inactivity. Games survive in the database, but players will reconnect.
- **Scale limit:** one backend instance owns all live rooms. Running two instances would need a Redis adapter and room sharding.

## Security measures in this phase

| Concern | Control |
|---|---|
| Identity | Random 32-byte token, only its SHA-256 hash stored. Sockets are refused without a valid token. |
| Spoofing | Player and room come from the server side session, never from payloads. Unknown payload keys are dropped. |
| Card privacy | Only `viewFor` projections and addressed events leave the server. Checked by tests on whole event logs. |
| Abuse | Per-socket token bucket, per-address REST limits, 10 KB JSON and 20 KB socket payload caps, CORS allow-list. |
| Duplicates | Per-room queue, request ids, and database unique keys (room code, user per room, seat per room, score per round and player, one live session per room). |
| Errors | One error shape. Unexpected errors are logged and the client only sees `INTERNAL`. |
| Logging | JSON lines. Tokens, hands, groups, piles and snapshots are redacted. |
