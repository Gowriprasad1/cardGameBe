# Phase 7: production readiness and deployment

## Status at a glance

| Item | State |
|---|---|
| Neon database: migrations, a whole game, cleanup | ✅ run against your Neon database (`npm run smoke`), passed |
| Production entrypoint (`NODE_ENV=production`) against Neon: health, headers, logs, SIGTERM shutdown | ✅ run locally |
| Production frontend build served with the strict CSP in a browser: styled, sign-in, WebSocket, no violations | ✅ checked locally |
| `npm audit` (backend and frontend, runtime and dev) | ✅ 0 vulnerabilities |
| Render service and Vercel project | 📝 configuration written, **not deployed** (needs your accounts) |

## Security review: what was checked

| Area | Finding / control |
|---|---|
| Secrets | None in the repository (searched). `DATABASE_URL` is read only from the environment. Logs redact tokens, hands, groups, piles, snapshots and connection strings (unit tested) |
| Identity | 32-byte random guest tokens, only the SHA-256 hash is stored. WebSocket handshake needs a valid token. Player and room are taken from the server's own record, never from payloads |
| Card secrecy | Only per-player views and addressed events leave the server; checked over whole games |
| Input | Every REST body and socket payload is validated against a schema, unknown fields are dropped, bodies are capped (10 KB REST, 20 KB socket) |
| Abuse | Per-address REST limits, per-socket event limits, one unfinished room per player, idle rooms abandoned, stale guests deleted after 90 days |
| Browser security | CORS allow-list for REST and the Socket.IO handshake. Backend sends `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Cache-Control: no-store` and HSTS in production. The frontend (Vercel) sends a strict Content-Security-Policy, frame blocking, HSTS and Permissions-Policy (`frontend/vercel.json`) |
| Database | Only parameterised SQL. TLS to Neon with full certificate verification (`sslmode` made explicit) |
| Failure behaviour | Production refuses to start without `DATABASE_URL` and a valid `CLIENT_ORIGIN`. Errors reach clients as one safe shape; unexpected ones are logged and shown only as `INTERNAL`. An uncaught exception exits so Render restarts the service, and games resume from the database |

Known limits, accepted for this release:

- The guest token lives in `localStorage`, so a cross-site-scripting bug would expose it. The CSP and Angular's output escaping are the defences; there are no cookies.
- WebSocket upgrade requests are not origin-checked (browsers do not enforce CORS on them), but they cannot do anything without the token, which is not a cookie, so cross-site WebSocket hijacking does not apply.
- Rate limits are kept in memory, per instance. One backend instance is assumed.
- No account system: a guest who clears browser storage loses that identity.

## Performance

- A normal move (draw, discard, drop, arrange) is **one** database statement and one round trip. Round start and end are single transactions of about 8 to 10 statements.
- Building a player's view takes about 0.03 ms; a whole saved game state is about 9 KB.
- Frontend: about 89 KB transferred on first load, other screens load on demand.
- Measured from this machine to Neon `us-east-2` the round trip is 300 to 600 ms, so a 3-round bot game took 30 s. That is distance, not load: **deploy Render in the same region as Neon** (Ohio) and the database part of a move drops to a few milliseconds. Players still pay their own distance to the backend.

## Deploy: step by step

You do these in your own accounts (I did not deploy anything, and the Render and Vercel connectors are not connected to this session).

### 0. Rotate the Neon password
The Neon connection string was pasted into a chat. In the Neon console reset the `neondb_owner` password (or create a new role) and use the new string below.

The code lives in two GitHub repositories: `Gowriprasad1/cardGameBe` (the `backend/` folder, files at the repo root) and `Gowriprasad1/cardGameFe` (the `frontend/` folder, files at the repo root).

### 1. Backend on Render (live at `https://cardgamebe.onrender.com`)
1. Render > New > **Web Service** > repository `cardGameBe`, branch `main`, region Ohio (same as Neon), **Root Directory empty**.
2. Build command `npm ci --omit=dev`, start command `npm run start`, instance type Free, health check path `/api/live`.
3. Environment: `NODE_ENV=production`, `NODE_VERSION=22`, `DATABASE_URL` (your Neon string), `AUTO_MIGRATE=true`, and `CLIENT_ORIGIN` (a placeholder like `https://placeholder.example` until step 3).
4. After the deploy, `https://cardgamebe.onrender.com/api/health` says `{"ok":true,"data":{"status":"up"}}`.

### 2. Frontend on Vercel
1. Vercel > Add New > Project > repository `cardGameFe`. **Root Directory empty** (the app is at the repo root). Framework preset: Angular (or Other; `vercel.json` sets the build command and output folder).
2. The backend address is already in `src/environments/environment.ts` (`https://cardgamebe.onrender.com`). Setting the Vercel environment variable `API_URL` replaces it at build time, for example if the backend moves.
3. Deploy. `vercel.json` handles page refreshes, `/room/CODE` invite links, caching and security headers.

### 3. Connect them
In Render set `CLIENT_ORIGIN` to your Vercel URL (no trailing slash, e.g. `https://card-game-fe.vercel.app`) and save (Render redeploys). A custom domain can be added as a second, comma separated entry.

### 4. Check it
```bash
cd backend
SMOKE_URL='https://cardgamebe.onrender.com' SMOKE_ORIGIN='https://YOUR-APP.vercel.app' npm run smoke
```
Then open the Vercel URL in two browsers (or one normal and one private window), create a room in one, join with the code in the other, and play a round.

## Operating notes

- **Free tier sleep:** Render's free web service sleeps after about 15 minutes without traffic and takes about a minute to wake. Games are saved after every move, so players reconnect to where they were, but the first visit after a pause is slow. A paid always-on instance avoids this.
- **Health checks:** Render uses `/api/live` (no database, so it does not keep Neon awake). `/api/health` also checks the database.
- **Logs:** JSON lines on stdout (Render > Logs). Each request has an id (`X-Request-Id`) that also appears in the log line.
- **One instance only.** Live rooms are held in that instance's memory and mirrored to the database. Running two instances would need a Redis adapter and room routing.
- **Backups and cost:** Neon keeps history on its own plan. Test data from `npm run smoke` is deleted by the script itself.
