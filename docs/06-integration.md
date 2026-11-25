# Integration (Phase 6): running the whole stack

## What has been verified, and how

| Link | Verified by | Result |
|---|---|---|
| Angular ↔ Express/Socket.IO (local) | Manual two-player run in a browser against `npm run dev:local`, including a game played to the winner screen | Works. CORS and WebSocket from `localhost:4200` to `localhost:3000` OK |
| Socket.IO clients ↔ server ↔ PostgreSQL, whole games | `backend/tests/integration/whole-game.test.js`: bots play full 2, 3, 4 and 5 player games to a winner; saved rounds, cards, scores, totals and history are checked against what the clients were told | Passes |
| Real `pg` driver + `src/db/pool.js` + migration runner | Same test file, last test: PGlite served over TCP so the production code path runs (BEGIN/COMMIT, simple-protocol migrations, typed results) | Passes |
| CORS for REST and the Socket.IO handshake | `api-and-rooms.test.js` | Allowed origin accepted, others refused |
| Neon itself | **Not verified.** No Neon connection string was available. Run the smoke test below | Pending, run by you |
| Render and Vercel | Not deployed yet (Phase 7) | Pending |

## Test it on your Neon database (about 1 minute)

1. In Neon, copy a connection string (a normal or a pooled one) for an empty database.
2. Run:

```bash
cd backend
DATABASE_URL='postgres://USER:PASSWORD@HOST/DB?sslmode=require' npm run smoke
```

The script applies the migrations, runs a whole 2-player game with bots through a real server, checks the saved rows (history, scores saved once, 54 cards per round stored once), prints the timing, and then deletes its own test data. It prints `PASSED` at the end. If it fails, send me the output (hide the password).

To apply only the migrations: `DATABASE_URL='...' npm run migrate`.

## Test a deployed backend

```bash
SMOKE_URL='https://your-service.onrender.com' SMOKE_ORIGIN='https://your-app.vercel.app' npm run smoke
```

It checks `/api/health`, that CORS allows your Vercel origin and refuses others, and plays a whole game over the public WebSocket. Its guests and room remain in that database (a few tiny rows).

## Connecting the three parts

| Setting | Where | Value |
|---|---|---|
| `DATABASE_URL` | Render environment | Neon connection string |
| `CLIENT_ORIGIN` | Render environment | Your Vercel URL, no trailing slash. Several allowed, comma separated |
| `AUTO_MIGRATE` | Render environment | `true` runs migrations at startup (optional) |
| `API_URL` | Vercel environment (build time) | Your Render URL. `npm run build` writes it into the production build via `scripts/set-api-url.mjs` |

## Things to know about Neon

- **Region:** put the Render service and the Neon project in the same region. Every accepted move is one transaction of about 4 round trips to the database, so cross-region latency is felt on every card.
- **Connection string:** both Neon's direct and pooled (PgBouncer) strings should work. The code uses transactions on one connection and unnamed parameterised statements only, which PgBouncer's transaction mode supports. This has not been tried on Neon yet; the smoke test will tell.
- **Scale to zero:** a Neon database that was idle needs a moment to wake up. The first request after a pause can be slow; the connection timeout is 10 seconds.
- **Free Render instances sleep.** Games survive in the database and clients reconnect, but expect a delay after inactivity.

## Changes made in this phase

- Backend tests got a whole-game bot suite and a real-driver test; `npm test` now takes about 4 minutes (the whole-game tests are the slow part).
- One saved query per move was removed by caching round ids.
- Socket rate limits are configurable (`SOCKET_BURST`, `SOCKET_RATE_PER_SECOND`); defaults unchanged (burst 20, 8 per second).
- `backend/scripts/smoke.js`, `frontend/scripts/set-api-url.mjs`, and a dev-only `DEV_ELIMINATION_THRESHOLD` for `dev-server.js` to see the end screens quickly.
