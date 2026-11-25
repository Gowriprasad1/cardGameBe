# Indian Rummy (13 cards): rules as implemented

The second game on the platform. It reuses everything except the rules: rooms, sockets, timers, reconnection, drops, scoreboard, elimination at the room's limit (101, 201 or 301), cleanup of finished games, and the Angular table. The rules live in `backend/src/games/rummy/`. These are standard pool-rummy rules; the settings can be changed in `rummy.config.js`.

## Setup

- 2 to 5 players (the room limit of the platform), 13 cards each. Two players use one deck, three to five use two decks.
- After the deal one card is turned face up: its **number is the wild joker** for the round. Printed jokers are also jokers.
- The elimination limit is chosen by the host when creating the room: 101, 201 (default) or 301.

## Melds

| Meld | Rule |
|---|---|
| **Pure sequence** | 3 or more consecutive cards of one suit, **no joker**. A wild-joker-number card may be used as its own card here. |
| **Sequence** | Consecutive cards of one suit where jokers fill gaps or ends. |
| **Set** | 3 or 4 cards of one number, **all different suits**. Jokers may fill in. |

- Ace is low (A-2-3) or high (Q-K-A). **K-A-2 does not wrap.**
- Printed jokers and every card of the wild-joker number can replace any card in a sequence or set. A wild-joker-number card is flexible: it can also stay itself.
- A meld needs at least one real card (`minNaturalInMeld: 1`), so a real card plus two jokers is valid. Jokers alone are not.
- If a group can be read as a sequence or a set, the stronger reading is used (pure, then sequence, then set).

## Turn

Draw one card (closed pile or the top of the open pile), arrange, discard one. **A printed joker thrown on the open pile cannot be picked up** (cards of the wild-joker number can). Timers, auto-play, auto-drop and reconnection work as in SET Game.

## Showing (declaring)

All 13 cards must be in valid melds with **at least one pure sequence and at least two sequences** (the pure one counts as one). The player sends the groups; the server checks them. A **wrong show costs 80 points** and the player is out of the round (`invalidDeclarationPolicy`, same options as SET Game).

## Drops

First drop (before the player's first turn): **20**. Later drop: **40**.

## Counting for the other players

Computed by the server, always with the arrangement that is best for the player:

| The player's hand | Count |
|---|---|
| No pure sequence anywhere | **Every card counts** |
| A pure sequence but no second sequence | Only the pure sequence is free. Sets and everything else count |
| A pure sequence and a second sequence | Every sequence and set is free. The rest counts |

Card values: A, K, Q, J, 10 = 10; 2 to 9 face value; **jokers and wild-joker-number cards = 0**. Nobody counts more than **80** in one round (`maxRoundPenalty`).

Examples (all tested): pure sequence + second sequence + sets with K, Q, 3, 2 left = 25. No pure sequence = capped at 80. Pure 4-5-6, sets of 7s and 9s and K, Q, 3, 2 left (no second sequence) = 73.

## Not in Rummy (decisions and limits)

- **1 CARD TO WIN** is not offered: for Rummy every suit and rank is a candidate card, and checking them all after every move would be too slow. The button is hidden and the server refuses it.
- **Opponents' hands are arranged by the server** (the best arrangement for them), not by the players after a show. This is faster and fair, but different from apps where each player arranges their cards against a timer.
- **Six players** are not supported: the platform's room limit is 5.
- No points-rummy or deals-rummy: only pool-style elimination.

## Settings (`rummy.config.js`)

`firstDropPenalty` 20, `middleDropPenalty` 40, `invalidDeclarationPenalty` 80, `maxRoundPenalty` 80, `minNaturalInMeld` 1, `maxSetSize` 4, `eliminationThreshold` 201 (set per room), `jokerValue` 0, `cardValues`, `invalidDeclarationPolicy`, timers.

## Code map

| File | Purpose |
|---|---|
| `melds.js` | What is a pure sequence, sequence or set (jokers, aces, wild-joker number) |
| `solver.js` | Finds winning or best-counting arrangements over every valid meld |
| `declaration.js` | Checks a show |
| `scoring.js` | Counts a hand |
| `rummy-rules.js` | Plugs these rules into the shared engine (`games/set/game-engine.js` `createEngine`) |
| `index.js` | The game module registered in `platform/game-registry.js` |

Database: migration `002_rummy.sql` adds the `RUMMY` game type and the `no_pure_sequence` score reason. With `AUTO_MIGRATE=true` it is applied at the next start; otherwise run `npm run migrate` (or `migrate:neon`).
