# Requirement → Implementation Checklist

Status legend: ✅ implemented and covered by passing tests · 📝 designed (docs/SQL only) · ⬜ not started.
Nothing is marked ✅ unless it was run and verified. Test command: `cd backend && npm test` (164 backend tests plus 18 frontend tests via `cd frontend && npm test`, all passing at the end of Phase 7; the backend suite takes about 4 minutes).

Test files: **D** `tests/unit/deck-shuffle-deal.test.js` · **G** `tests/unit/groups-life-jokers.test.js` · **S** `tests/unit/declaration-scoring.test.js` · **E** `tests/unit/engine-flow.test.js` · **I** `tests/integration/simulated-games.test.js` · **R** `tests/integration/api-and-rooms.test.js` · **P** `tests/integration/gameplay.test.js` · **T** `tests/integration/timers.test.js` (R, P, T run a real HTTP + Socket.IO server on an in-process PostgreSQL)

| # | Requirement (spec §) | Implementation | Phase | Status |
|---|---|---|---|---|
| 1 | Tech stack fixed (§1) | `docs/01-architecture.md` | 2 | 📝 |
| 2 | 2 players = 1 deck, 3–5 = 2 decks, 13 cards each (§2) | `deck.service`, `card-distribution.service` · D, E | 3 | ✅ |
| 3 | Unique physical card instance ids (§2, §5) | `deck.service`, engine integrity check on every action · D, I | 3 | ✅ |
| 4 | Create / join room, copy code, max 5, min 2, no duplicates (§3) | `room.service`, `room_players` unique keys · R | 4 | ✅ backend (copy button is UI, Phase 5) |
| 5 | Join validation: exists, capacity, not started (§3) | `room.service`, `GET /api/rooms/:code` · R, P | 4 | ✅ |
| 6 | Host-only start, freeze players (§3) | `room.service.startGame` · R | 4 | ✅ |
| 7 | Backend random dealer, rotate each round (§4) | `dealer.service` · D, E | 3 | ✅ |
| 8 | Secure shuffle, Open Joker, deal, piles (§5) | `shuffle.service` (crypto), `card-distribution.service` · D | 3 | ✅ |
| 9 | Never send opponent cards or the deck (§5, §18) | `view.js` + event addressing · E, I (checked on every step of round 1) | 3 | ✅ engine · socket layer in Phase 4 |
| 10 | Group = 3+ same rank (§6A) | `set-validation.service` · G | 3 | ✅ |
| 11 | LIFE = exactly 4 natural, no joker (§6B, clarified by the product owner) | `life-validation.service` · G, S (mutation-checked) | 3 | ✅ |
| 12 | Printed + Open Joker wildcards in normal groups only (§6C) | `joker.service` · G | 3 | ✅ |
| 13 | Draw/discard turn flow, no out-of-turn, no duplicates (§7) | `turn.service`, `game-engine` · E, I | 3 | ✅ |
| 14 | Configurable turn timer; disconnect/reconnect (§7) | engine `timeout` action + platform timers, presence, `resume`, restart recovery · E, I, P, T | 3 / 4 | ✅ |
| 15 | Declaration: all 8 checks (§8) | `declaration.service` · S, E | 3 | ✅ |
| 16 | Invalid declaration = 40, once only, configurable policy (§8) | `game-engine` `doDeclare`, `chargePenalty` · S, E | 3 | ✅ |
| 17 | First drop 20 / middle drop 40, never both (§9) | `scoring.service.dropPenalty`, `game-engine` `doDrop` · S, E | 3 | ✅ |
| 18 | 1 CARD TO WIN eligibility and privacy (§10), "waiting for a card" rule | `one-card-to-win.service` · S, E, `rules-update.test.js` | 3 | ✅ |
| 19 | Card values, unmatched-only scoring, min-points grouping (§11) | `arrangement.service`, `scoring.service` · S, I | 3 | ✅ |
| 20 | No-LIFE hand counting (only cards outside valid sets; jokers need a LIFE and count 2 without one), configurable and documented (§11) | `set.config.js`, `02-game-rules.md` · S | 3 | ✅ |
| 21 | Elimination at ≥ 201, history kept, spectators (§12) | `elimination.service`, `game-engine` · S, E, I | 3 | ✅ |
| 22 | Game ends with one player, final scoreboard data (§12) | `game-completed` event, `game_history` row · E, I, P | 3 / 4 | ✅ (screens in Phase 5) |
| 23 | Live scoreboard + round history (§13) | `scoreboard-updated`, `player_scores`, `GET /api/sessions/:id/history` · E, I, P | 3 / 4 | ✅ (screens in Phase 5) |
| 24 | All 19 screens, premium dark-green UI, no Tailwind (§14) | `frontend/` (see `docs/05-frontend.md`); plain CSS, Angular standalone components | 5 | ✅ built and checked in a browser against the local backend; winner and elimination screens covered by component tests only |
| 25 | Socket events and acks (§15) | `socket/index.js`, `docs/03-api-and-socket-contract.md` · R, P, T | 2 / 4 | ✅ |
| 26 | DB schema, transactions (§16) | `001_init.sql`, `game-persistence.service` (one transaction per deal / action / round end / game end) · P | 2 / 4 | ✅ verified on an embedded Postgres engine; **not yet run against Neon** |
| 27 | Layered backend, pure engine (§17) | routes, controllers, services, repositories, socket handlers, middleware, validators; engine has no Express/Socket.IO/DB imports | 3 / 4 | ✅ |
| 28 | Security and reliability controls (§18) | `docs/04-backend.md` security table · R, P | 4 / 7 | ✅ implemented; independent audit is Phase 7 |
| 29 | Unit-test topics 1–25 (§19) | see table below | 3 | ✅ except #24 |
| 30 | Multiplayer integration tests (§19) | see table below | 3 / 4 / 6 | ✅ |
| 31 | Vercel / Render deployment | `render.yaml`, `frontend/vercel.json`, `docs/07-deployment.md` | 7 | 📝 config written and checked locally; **not deployed** (needs your Render and Vercel accounts) |
| 34 | Production readiness: security audit, performance, error handling, logging (Phase 7) | `docs/07-deployment.md` | 7 | ✅ |
| 35 | Neon database verified end to end | `npm run smoke` on your Neon database, plus the production entrypoint against it | 6 / 7 | ✅ |
| 33 | Angular ↔ Express ↔ Socket.IO ↔ PostgreSQL, full multiplayer games | `whole-game.test.js` (2–5 bots over sockets, real `pg` driver), browser run to the winner screen | 6 | ✅ on a Postgres engine · ⬜ on Neon (run `npm run smoke`) |
| 32 | Documentation of APIs, schema, events, rules (§21.16) | `docs/` | 2 / 3 | ✅ updated for Phase 3 |

## Unit-test topics from the spec (§19)

| # | Topic | Where tested |
|---|---|---|
| 1 | Deck generation | D |
| 2 | One-deck configuration | D |
| 3 | Two-deck configuration | D |
| 4 | Card shuffling | D (incl. unbiased check) |
| 5 | Card distribution | D, E |
| 6 | 13-card validation | S (WRONG_CARD_COUNT), D |
| 7 | Three-card group validation | G |
| 8 | Four-natural-card LIFE | G |
| 9 | Joker not allowed in LIFE | G, S |
| 10 | Joker substitution in normal groups | G |
| 11 | Open Joker validation | G |
| 12 | Multiple Joker validation | G, S |
| 13 | Valid declaration | S, E |
| 14 | Invalid declaration | S, E |
| 15 | 40-point invalid declaration penalty | S, E |
| 16 | First drop 20 | S, E |
| 17 | Middle drop 40 | S, E |
| 18 | Unmatched card calculation | S |
| 19 | Valid group exclusion from scoring | S |
| 20 | 201-point elimination | S, E |
| 21 | Multiple player elimination | S, E |
| 22 | One Card To Win eligibility | S, E |
| 23 | Turn validation | E |
| 24 | Room capacity validation | R (sixth player gets `ROOM_FULL`, preview shows not joinable), E |
| 25 | Duplicate card prevention | D, I |

## Multiplayer integration tests (§19)

| Test | Status |
|---|---|
| 2-, 3-, 4-, 5-player full games | ✅ I (bots play whole games over many rounds) |
| Simultaneous actions | ✅ I (engine), P (real concurrent sockets: one wins, others get `NOT_YOUR_TURN` / `ALREADY_*`, same `requestId` applied once) |
| Player reconnection | ✅ P (new socket, `resume` returns the same hand), I, and a full server restart restored from PostgreSQL (P) |
| Player disconnection | ✅ P (others notified, seat kept), T (turn auto-played after the grace period, timer auto-play and auto-drop) |
| Invalid room ID / full room | ✅ R |
| Eliminated player attempting to rejoin | ✅ P (stays as a spectator, cannot act, not dealt into round 2; strangers get `ROOM_STARTED`) |

## Open items needing the product owner

1. **Open Joker cards and LIFE.** With the confirmed "all cards of the Open Joker rank are wild" decision, four cards of that rank cannot form LIFE. Engine option `openJokerNaturalInOwnRank` defaults to `false`. Confirm or flip it.
2. Defaults accepted as proposed: minimize-points scoring, no-LIFE hand counts every non-joker card, spectators for eliminated players, reshuffle on empty draw pile, 60 s timer / auto-drop after 3 timeouts / 90 s reconnect grace.
3. **Additions made while implementing** (not in the original defaults): declaring is also allowed at the start of your next turn with 13 cards (not only right after the discard); `discard` ends the turn by default, `endTurn: false` keeps it open to declare; cumulative scores change once at round end, so elimination is decided then, not mid-round.
4. **Phase 4 decisions** (please confirm): one unfinished room per user at a time (`ALREADY_IN_ROOM`); leaving a game in progress is not allowed (disconnecting is, and timeouts auto-drop after 3 turns); guests only, no accounts; rooms nobody has joined for 30 minutes are abandoned; the engine's player ids are the user ids.
5. **Not verified against Neon.** The SQL and transactions ran on an embedded PostgreSQL engine (PGlite). The `pg` connection wrapper (`src/db/pool.js`) and a real `DATABASE_URL` have not been exercised, because no Neon connection string is available here. First step of Phase 6: run `npm run migrate` and one full game against Neon.
6. **Phase 5 notes.** The 1 CARD TO WIN button follows a server-computed flag (`oneCardEligible`), so it is enabled only when the server says the hand qualifies. A bug found while testing in the browser (`removed_invalid_declaration` did not fit a `VARCHAR(24)` column, so a 2-player invalid declaration failed with INTERNAL) is fixed in `001_init.sql` with a regression test. **If you already ran `001_init.sql` on a database, recreate it or run `ALTER TABLE round_players ALTER COLUMN status TYPE VARCHAR(32)`.**
7. **Not done in Phase 5:** no Playwright/Cypress end-to-end suite (the two-player run was done by hand in the browser pane, with a scripted opponent); drag-and-drop card arrangement (tap-to-select is used instead); sound effects; the Open Joker/LIFE decision from item 1 is still open.
8. **Neon verified (Phase 6/7).** `npm run smoke` passed against your Neon database and the production entrypoint ran against it. Test data was removed. **Your Neon password was pasted into chat: please reset it** (see `docs/07-deployment.md`).
9. **Not deployed.** Render and Vercel are configured (`render.yaml`, `frontend/vercel.json`) but not deployed; follow `docs/07-deployment.md`. Not yet tried on the real hosts: the first Render cold start, WebSocket through Render's proxy, and the CSP against the real API domain.
10. **Rules clarified by the product owner after Phase 7:** (a) a LIFE is exactly 4 natural cards (five 9s + three 6s + five 2s is not a winning hand); (b) 1 CARD TO WIN means waiting for one card that completes the hand (three examples added as tests); (c) a printed joker on the open pile cannot be taken, a card of the open-joker number can. Tests: `backend/tests/unit/rules-update.test.js`. Note: for the five 9s / three 6s / five 2s hand the engine scores the best arrangement for the player, a LIFE of four 2s leaving one 2 (2 points), not a LIFE of 9s leaving a 9.
11. **Counting rules clarified by the product owner:** (a) a hand without a LIFE still counts only its cards outside valid sets (four sets + an 8 = 8); (b) jokers only work with a LIFE; without one, the jokers count 2 each only when every natural card is in a set (four sets + a joker = 2), otherwise only the loose cards count (three sets + 5,5 + two jokers = 10); (c) with a LIFE, one natural card plus two jokers is a valid set (LIFE + set + 2 jokers + 2, K, J, Q = 22). This changes the earlier defaults (`noLifeHandPolicy` was `all-cards`, `minNaturalInJokerGroup` was 2). Tests: `backend/tests/unit/declaration-scoring.test.js`.
12. **Frontend additions:** a rules pop-up (must press OK) every time SET Game is chosen, and the home page shows the platform name **Pekata** (`frontend/src/app/core/brand.ts`) instead of "SET Game". Pekata is the name you chose; I cannot check whether it is free or trademarked.
13. **Database cleanup (added on request).** When a game ends only its result is kept; cards, the action log and the saved state are deleted. Finished or abandoned rooms older than 30 days (`DATA_RETENTION_DAYS`, 0 = never) are deleted completely. The 30 day default is my choice: tell me if finished results should be kept longer or forever. Tests: `backend/tests/integration/cleanup.test.js`.
14. **Room points limit (added on request).** The host picks 101, 201 (default) or 301 in a dropdown when creating a room; it is saved with the room, shown in the waiting room and on the table, survives a server restart, and decides who is eliminated. This refines the fixed 201 from the original spec. Tests: `api-and-rooms.test.js`, `gameplay.test.js`, `frontend/.../lobby.spec.ts`.
15. **Indian Rummy added as the second game (on request).** Rules and decisions are in `docs/08-rummy-rules.md`. I chose the standard pool-rummy defaults without asking first (pure plus second sequence, 20/40 drops, wrong show 80, count capped at 80, wild-joker number, server-arranged opponent hands, no 1 CARD TO WIN, 2 to 5 players); please check them. The shared turn engine was refactored into `createEngine(rules)` and SET's 190+ tests still pass unchanged. Migration `002_rummy.sql` must run on your Neon database (automatic with `AUTO_MIGRATE=true`). Tests: `rummy.test.js`, `rummy-game.test.js`, frontend specs.
