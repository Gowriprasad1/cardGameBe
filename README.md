# SET Game: backend

Node.js + Express + Socket.IO API and the SET game engine for a free, points-only multiplayer card game (2 to 5 players). No money, no betting. PostgreSQL (Neon) for storage. The Angular frontend lives in the **cardGameFe** repository.

## Run locally (no database account needed)

```bash
npm install
npm run dev:local        # API on http://localhost:3000, embedded PostgreSQL (data lost on exit)
npm test                 # unit + integration tests (about 4 minutes; `npm run test:unit` is fast)
```

## Run against a real database (Neon)

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST/DB?sslmode=require'
export CLIENT_ORIGIN='http://localhost:4200'
npm run migrate          # apply db/migrations
npm start
npm run smoke            # plays a whole bot game against that database and cleans up
```

## Deploy

`render.yaml` is a Render Blueprint. Set `DATABASE_URL` and `CLIENT_ORIGIN` (your frontend URL) when prompted. Full steps: `docs/07-deployment.md`.

## Documentation

`docs/` holds the architecture, game rules, API and socket contract, backend and integration notes, the deployment guide and the requirement checklist. Some of those pages were written when backend and frontend shared one folder: read "`backend/`" as this repository's root and "`frontend/`" as the cardGameFe repository.
