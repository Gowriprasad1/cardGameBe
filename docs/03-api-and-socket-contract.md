# REST and Socket.IO Contract

Backend is the source of truth. Clients send **intents**; the server validates and answers with **views**.
No payload ever contains another player's cards, the draw pile contents or the full deck.

## 1. Identity

1. `POST /api/guests` → creates a guest user, returns `{ userId, nickname, token }`. The token is a random 32-byte value; only its SHA-256 hash is stored.
2. The client keeps the token in `localStorage` and sends it in the Socket.IO handshake: `io(url, { auth: { token } })`.
3. The socket middleware resolves the token to a user and attaches `socket.data.userId`. Every event handler derives identity from this, **never** from the payload.

## 2. REST (Express)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness and DB check. |
| GET | `/api/games` | List available games (`SET`) with player limits. |
| POST | `/api/guests` | Create a guest, `{ nickname }` (2 to 30 letters, digits, space, `_ . ' -`) → `201 { userId, nickname, token }`. |
| GET | `/api/me` | Bearer token → `{ userId, nickname, activeRoomCode }`. Lets a returning client know whether to `resume`. |
| GET | `/api/rooms/:code` | Public room preview `{ roomCode, gameType, status, playerCount, maxPlayers, joinable }`. 404 `ROOM_NOT_FOUND` for an unknown code. |
| GET | `/api/sessions/:id/history` | Round-by-round scores `{ rounds: [{ roundNo, endReason, scores: [...] }] }`. Bearer token of a participant only. `sessionId` is in the room payload. |

Success bodies are `{ "ok": true, "data": ... }`. Errors use one shape:

```json
{ "ok": false, "error": { "code": "ROOM_FULL", "message": "Room is full" } }
```

## 3. Socket.IO acknowledgement shape

Every client→server event uses an ack callback and gets one of:

```json
{ "ok": true,  "data": { } }
{ "ok": false, "error": { "code": "NOT_YOUR_TURN", "message": "It is not your turn" } }
```

Mutating game events carry `{ requestId }` (UUID). Repeating a `requestId` returns the original result and changes nothing (idempotency).

Success data of a game action: `{ duplicate: boolean, view }` where `view` is the caller's private view and `duplicate: true` means the `requestId` had already been processed.

Platform error codes: `UNAUTHENTICATED`, `VALIDATION_FAILED` (with `details.field`), `UNSUPPORTED_GAME`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_STARTED`, `ROOM_CLOSED`, `NOT_HOST`, `NOT_ENOUGH_PLAYERS`, `NOT_IN_ROOM`, `ALREADY_IN_ROOM` (with `details.roomCode`), `GAME_IN_PROGRESS`, `GAME_NOT_STARTED`, `FORBIDDEN`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `NOT_FOUND`, `INTERNAL`.

Game error codes (from the engine): `NOT_YOUR_TURN`, `ALREADY_DRAWN`, `MUST_DRAW_FIRST`, `ALREADY_DISCARDED`, `TURN_NOT_FINISHED`, `CARD_NOT_IN_HAND`, `PILE_EMPTY`, `INVALID_ARRANGEMENT`, `PLAYER_ELIMINATED`, `NOT_IN_ROUND`, `ROUND_NOT_ACTIVE`, `GAME_FINISHED`, `DROP_NOT_ALLOWED`, `DECLARATION_NOT_ALLOWED`, `ONE_CARD_NOT_ELIGIBLE`, `NOT_BETWEEN_ROUNDS`.

## 4. Client → Server events

| Event | Payload | Rules checked |
|---|---|---|
| `create-room` | `{ gameType: "SET" }` | Authenticated. Creates room, creator is host and seat 0. Returns `{ roomCode, room }`. |
| `join-room` | `{ roomCode }` | Room exists, status `waiting`, not full, user not already in room (rejoin handled separately), user not eliminated in an active game. |
| `leave-room` | `{}` | Only in `waiting`. Host leaving transfers host or closes room. |
| `start-game` | `{}` | Host only, 2–5 players, room `waiting`. Freezes the player list. |
| `resume` | `{ roomCode }` | Reconnection. Re-binds the socket to the seat and returns the full private view. |
| `draw-card` | `{ requestId, source: "draw" \| "discard" }` | Active turn, round live, no card drawn yet this turn. |
| `discard-card` | `{ requestId, cardId, endTurn? }` | Active turn, card already drawn, card in own hand. Ends the turn unless `endTurn: false`, which keeps it open so the player can declare. |
| `end-turn` | `{ requestId }` | Only after a discard made with `endTurn: false`. |
| `arrange-cards` | `{ requestId, groups: string[][] }` | Cards must be exactly the player's hand, no duplicates. Stored so a reconnect restores layout. Allowed any time during a live round (not turn-gated). |
| `declare-game` | `{ requestId, groups: string[][] }` | Active turn, exactly 13 cards (after a discard with `endTurn: false`, or at the start of the turn before drawing). Server runs full validation. |
| `player-drop` | `{ requestId }` | Active turn, before drawing. Server decides first vs middle drop. |
| `one-card-to-win` | `{ requestId, active: boolean }` | Turning on re-checks eligibility server-side. Turning off is always allowed. |
| `next-round-ready` | `{}` | Acknowledge the round result screen. When every connected, non-eliminated player has done so the next round is dealt at once; otherwise it is dealt after `ROUND_BREAK_SECONDS`. Returns `{ started }`. |

`leave-room` is allowed while the room is waiting or finished, and refused (`GAME_IN_PROGRESS`) during a game. `join-room` by someone already seated just reconnects them (`rejoined: true`). `resume` returns `{ roomCode, room, view }`; `view` is `null` before the game starts.

## 5. Server → Client events

Room (to everyone in the room):

| Event | Payload |
|---|---|
| `room-updated` | `{ roomCode, status, hostId, maxPlayers, players: [{ playerId, nickname, seat, isHost, isConnected, status }] }` |
| `player-joined` | `{ playerId, nickname, seat }` |
| `player-left` | `{ playerId, reason }` |
| `player-disconnected` / `player-reconnected` | `{ playerId }` |

Game (public, to everyone):

| Event | Payload |
|---|---|
| `game-started` | `{ sessionId, players (in seat order), deckCount, config (public subset) }` |
| `dealer-selected` | `{ roundNo, dealerId }` |
| `cards-distributed` | `{ roundNo, openJokerRank, discardTop, drawPileCount, handCounts: { playerId: 13 } }` |
| `player-turn` | `{ playerId, turnNo, deadlineAt }` |
| `card-drawn` | `{ playerId, source }` (never the card, unless the source is the discard pile, whose top card is public) |
| `card-discarded` | `{ playerId, card, drawPileCount }` (discards are public) |
| `one-card-to-win` | `{ playerId, active }` |
| `player-drop` | `{ playerId, type: "first" \| "middle", penalty }` |
| `declaration-result` | `{ playerId, valid, penalty?, policy }` — never includes the declared groups of a failed attempt |
| `player-eliminated` | `{ playerId, cumulativeScore, roundNo }` |
| `round-completed` | `{ roundNo, winnerId, endReason, results: [{ playerId, penalty, reason, cumulativeScore, revealedGroups? }] }` — hands are revealed only at round end for the declarer and scored players |
| `scoreboard-updated` | `{ scoreboard: [{ playerId, nickname, cumulativeScore, roundPenalty, drops, status, isWinner }] }` |
| `game-completed` | `{ winnerId, totalRounds, finalScoreboard, eliminatedHistory }` |

Private (to the owning socket only):

| Event | Payload |
|---|---|
| `game-state` | The caller's complete `viewFor` projection (own hand, hand counts of others, piles, scoreboard, history). Sent to every seated player after every accepted action, so a client can simply render the latest one. |
| `hand-updated` | `{ roundNo, cards: [{ id, rank, suit, isPrintedJoker, isOpenJoker }], groups }` — sent after deal, draw, discard, arrange |
| `declaration-errors` | `{ errors: [{ code, message, groupIndex? }] }` — only to the declarer after a failed declaration |
| `private-view` | Full recovery view: own hand, arrangement, turn state, public table state (the engine's `viewFor`) |

The engine also accepts two server-only actions that clients can never send: `timeout` (fired by the turn timer) and `start-next-round` (fired by the platform after the round-result screen).

Penalties are recorded per round immediately, but cumulative scores and eliminations change once, when the round ends (`round-completed`, then `player-eliminated`, then `scoreboard-updated`).

Note: `isOpenJoker` is derived on the server so clients cannot disagree about which cards are wild.

## 6. Game lifecycle

```
waiting ──start-game──▶ session in_progress
   │                         │
   │                 ┌───────▼────────┐
   │                 │ round N starts │ dealer (random for round 1, rotates after)
   │                 │ shuffle+deal   │
   │                 └───────┬────────┘
   │                         │
   │          ┌──────────────▼──────────────┐
   │          │ turn loop (active player)   │◀───────────────┐
   │          │ draw → arrange → discard    │                │
   │          └───┬──────────┬──────────┬───┘                │
   │              │          │          │                    │
   │           drop      declare     timeout            next player
   │              │          │          │                    │
   │              │   valid? ┴─ no → 40 pts, remove ─────────┤ (round continues)
   │              │          │ yes                           │
   │              ▼          ▼                               │
   │        one player left / valid declaration              │
   │                         │                               │
   │              score round, update totals (one transaction)
   │                         │
   │          any player ≥ 201 → eliminated
   │                         │
   │        ┌────────────────┴──────────────┐
   │   2+ players left                  1 left
   │        │                              │
   │   round N+1 (dealer rotates)    game-completed → history written → room finished
```

## 7. Server-side action pipeline

1. Socket handler authenticates, validates payload shape, resolves room and seat.
2. It calls `GameSessionService.perform(roomCode, playerId, action)`.
3. The service runs the action inside a **per-room queue** so two simultaneous actions can never interleave, and checks the idempotency key.
4. The pure engine returns `{ state, events }`. Nothing else changes game state.
5. Critical events (deal, round end, scoring, elimination, completion) are persisted in one DB transaction together with the state snapshot and version bump. Other actions append to `game_actions` and snapshot asynchronously with a bounded delay.
6. Events are projected per recipient (`viewFor(player)`) and emitted. Handlers never touch cards themselves.
