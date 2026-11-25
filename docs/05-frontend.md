# Frontend (Phase 5)

Angular 22 (standalone components, signals, zoneless), TypeScript, HTML and plain CSS. No Tailwind and no UI library. Runtime dependencies: Angular itself and `socket.io-client`.

## Run it

```bash
# terminal 1: backend without a Neon database (embedded PostgreSQL, data lost on exit)
cd backend && npm install && npm run dev:local     # http://localhost:3000

# terminal 2: frontend
cd frontend && npm install && npm start            # http://localhost:4200
```

With a real Neon database run the backend as described in `docs/04-backend.md` instead of `dev:local`.

- `npm test` in `frontend/` runs the unit tests (Vitest + jsdom, no browser needed).
- `npm run build` makes the production build in `dist/frontend/browser`.
- API address: `src/environments/environment.development.ts` (local) and `src/environments/environment.ts` (production build, set `apiUrl` to your Render URL before deploying).
- Two players in one browser: open the second tab with `?profile=two` on the first URL, for example `http://localhost:4200/?profile=two`. Each profile keeps its own guest identity.

## Structure

```
src/app/
  core/                  no UI
    models.ts            types of everything the server sends
    api.service.ts       REST calls (guest, me, room preview)
    session.service.ts   guest identity in localStorage, token validation
    socket.service.ts    the only place that uses socket.io-client
    game.store.ts        room + private game view, overlay queue, all player actions
    hand-ops.ts          pure helpers for grouping/sorting my cards (unit tested)
    labels.ts            card names, reasons, friendly error text
    toast.service.ts
  shared/                reusable components
    playing-card, card-pile, player-seat, joker-badge, scoreboard,
    modal, countdown, toast-host
  features/
    home/                Home, Game selection
    lobby/               Create room / Join room
    room/                Room page (loads by code), Waiting room
    table/               Game table, Hand, Drop and Declare dialogs, Dealer and Deal overlays
    results/             Round result, Elimination notice, Winner screen
```

## How it works

- **The server decides everything.** The store only keeps the latest `room` and private `view` the server sent (`game-state` after every accepted action) and turns clicks into socket events. The client never validates a declaration, scores a hand or decides whether 1 CARD TO WIN is allowed; the server sends `oneCardEligible` in the view and the button follows it.
- **Reconnect:** on reload or after a dropped connection the store reconnects and calls `resume`, so the hand, layout, turn and countdown come back. The countdown deadline is part of every view (`turnDeadlineAt`).
- **Invite links:** `/room/CODE` joins the room automatically if you are not in it yet.
- **Hand layout:** tap cards to select, then Group, Ungroup or Sort. The layout is saved on the server (`arrange-cards`) so it survives a reload. It is only a layout; the server checks the groups when you declare.
- **Turn flow in the UI:** tap the draw pile or the open pile, select one card, then Discard (ends the turn) or Discard & declare (keeps the turn open and opens the declaration screen). Declare is also available at the start of your turn when you hold 13 cards. Drop asks for confirmation and shows the penalty.
- **Full-screen moments** (dealer selection, dealing, round result, elimination) are queued in order. The final screen is the winner screen.

## Screens (all 19 from the specification)

| # | Screen | Where |
|---|---|---|
| 1 | Home | `features/home/home` |
| 2 | Game selection | `features/home/game-select` |
| 3 | Create room | `features/lobby/lobby` |
| 4 | Join room | `features/lobby/lobby` |
| 5 | Waiting room | `features/room/waiting-room` |
| 6 | Dealer selection | `features/table/overlays` (DealerOverlay) |
| 7 | Card distribution | `features/table/overlays` (DealOverlay) |
| 8 | Main game table | `features/table/game-table` |
| 9 | Player seating area | `shared/player-seat` |
| 10 | Card arrangement | `features/table/hand` |
| 11 | Draw pile | `shared/card-pile` |
| 12 | Discard pile | `shared/card-pile` |
| 13 | Open joker display | `shared/joker-badge` |
| 14 | Drop confirmation | `features/table/dialogs` (DropDialog) |
| 15 | Declaration screen | `features/table/dialogs` (DeclareDialog) |
| 16 | Live scoreboard | `shared/scoreboard` (in a modal on the table) |
| 17 | Round result | `features/results/results` (RoundResultDialog) |
| 18 | Player elimination | `features/results/results` (EliminationDialog) |
| 19 | Final winner screen | `features/results/results` (WinnerScreen) |

## Design

Dark-green felt table with a wooden rim, ivory cards, warm amber accent (no chips, coins or money imagery). Georgia for headings and card faces, system fonts for the interface. Colours, sizes and radii are CSS variables in `src/styles.css`. Responsive from 360 px wide: cards fan out so 13 cards fit on a phone, seats keep an arc across the top of the table. Animations respect `prefers-reduced-motion`. Cards are real buttons with spoken names ("Queen of Hearts"), dialogs close with Escape (except result screens), and the hint line is a live region that announces whose turn it is.

## Deployment notes (Vercel)

`vercel.json` serves `index.html` for every path so `/room/CODE` links work. Set `apiUrl` in `src/environments/environment.ts` to the Render URL, and put the Vercel domain in the backend's `CLIENT_ORIGIN`.
