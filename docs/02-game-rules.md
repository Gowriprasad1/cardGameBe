# SET Game – Rules, Decisions and Configuration

Free, points-based entertainment game. Points have no monetary value. There is no betting, deposit, withdrawal or payment of any kind.

## 1. Setup

| Players | Decks | Cards dealt each |
|---|---|---|
| 2 | 1 (54 cards) | 13 |
| 3–5 | 2 (108 cards) | 13 |

- A deck is 52 cards (4 suits × A,2–10,J,Q,K) plus 2 printed jokers.
- Every physical card has a unique instance id, e.g. `D1-H-7`, `D2-S-K`, `D1-JK-1`.
- Per round: shuffle (crypto-secure Fisher–Yates), reveal **Open Joker rank**, deal 13 each, flip 1 card to start the discard pile, the rest is the draw pile.
- Dealer is picked randomly by the backend for round 1, then rotates clockwise each round (skipping eliminated players). The player after the dealer plays first.

## 2. Groups, LIFE and jokers (confirmed decisions)

| # | Rule | Decision |
|---|---|---|
| A | Valid group | At least 3 cards of one rank. |
| B | LIFE (mandatory) | At least one group with **4 or more natural** cards of the same rank. A joker never counts toward LIFE. |
| C1 | Printed joker | Always a wildcard in normal groups. |
| C2 | **Open Joker** | The revealed card's **rank** is the Open Joker rank. Every card of that rank is a wildcard (`openJokerMode: "rank"`), exactly like a printed joker. They are never natural, so they cannot form or complete LIFE. See the open question below. |
| C3 | **Joker in groups** | A normal group needs at least **2 natural** cards (`minNaturalInJokerGroup: 2`). `5,5,Joker` is valid. `5,Joker,Joker` is not. |
| C4 | **Joker in a LIFE group** | A group with 4+ natural cards is LIFE. Any extra joker placed in it is allowed as a filler but is not counted toward LIFE (`jokerInLifeGroup: "extra-only"`). |
| C5 | Joker reuse | A card belongs to exactly one group. |

**Open question (not yet confirmed by the product owner).** Under C2, if the Open Joker rank is 7, a player holding four 7s cannot make LIFE with them, because those cards are wildcards. This is the strict reading of "jokers are not allowed in LIFE". The alternative is to let cards of the Open Joker rank count as natural in a group of their own rank. The engine will expose this as `openJokerNaturalInOwnRank` (default `false`) so either answer is a one-line change.

## 3. Turn flow

1. Draw one card from the closed draw pile **or** the open discard pile (only once per turn).
2. Optionally rearrange (private, server stores the arrangement; allowed at any time during a round).
3. Discard exactly one card.
4. End the turn. `discard` ends the turn automatically unless the client sends `endTurn: false`, which keeps the turn open so the player can declare. The turn then passes to the next active player.

Turn phases the engine enforces: `awaiting-draw` → `awaiting-discard` → `awaiting-end-turn`.

- Only the active player may draw, discard, end the turn, declare or drop. A drop is only allowed in `awaiting-draw` (start of their own turn, before drawing).
- A hand always has 13 cards at rest and 14 between draw and discard.
- If the draw pile is empty, the discard pile (except its top card) is reshuffled (`reshuffleOnEmpty: true`).
- Turn timer default 60 s (`turnTimerSeconds`, 0 = off). On timeout the server auto-discards the drawn card (or draws then discards the drawn card). After 3 consecutive timeouts the player is auto-dropped (`autoDropAfterTimeouts: 3`).
- Disconnected players keep their seat for a 90 s grace period (`reconnectGraceSeconds`), then are treated as timed-out until they return.

## 4. Declaration

Allowed only on the player's own turn while holding exactly 13 cards: either right after discarding with `endTurn: false` (`awaiting-end-turn`), or at the start of the next turn before drawing (`awaiting-draw`). It is rejected while holding 14 cards. (The second window is an addition to the "declare after discard" default, so a player who ended their turn can still declare on their next turn.) The client sends the proposed groups (card ids). The backend checks:

1. Exactly 13 cards, each owned by the player.
2. Every card used exactly once, none twice.
3. At least one LIFE (4+ natural same rank).
4. No joker counted toward LIFE.
5. Every group has 3+ cards.
6. Groups with jokers have at least 2 natural cards.

**Valid:** declarer wins the round, scores 0. Every other player still in the round is scored (section 6).

**Invalid:** declarer gets exactly **40** penalty points, is removed from the round (`invalidDeclarationPolicy: "remove-declarer"`), and the round continues. If only one player remains, that player wins the round with 0. Other values supported by the config:

- `"continue-declarer"`: the declarer keeps the 40 and keeps playing; a second failed declaration removes them with no extra points.
- `"end-round"`: the round ends at once with no winner. Only the declarer pays 40, everyone else gets 0.

The declarer alone is told what was wrong (`declaration-errors`, private). The attempted groups are never broadcast.

**When points are added.** Penalties are recorded against the round immediately (the scoreboard's "round penalty"). The cumulative score changes exactly once, when the round ends, and elimination is decided at that moment.

The 40-point amount is fixed and is not configurable. The penalty can be applied only once per player per round.

## 5. Drops

| Type | When | Penalty |
|---|---|---|
| First drop | Player has completed 0 turns this round | 20 |
| Middle drop | Player has completed 1 or more turns | 40 |

The player leaves the round's turn order immediately. A player can never receive both drop penalties in the same round, and a dropped player cannot also be charged for an invalid declaration in that round.

## 6. Scoring

Card values (configurable): 2–10 face value, J/Q/K/A = 10, validly used joker = 0.

After a valid declaration, each other remaining player's hand is scored on **unmatched cards only**:

- The scorer searches all groupings and chooses the one with the **lowest remaining points** (`scoringObjective: "min-points"`).
- Cards in valid groups are not counted. Jokers used in valid groups count 0.
- An unmatched joker counts 0 (`unmatchedJokerValue: 0`).
- **Hand with no LIFE:** treated as not eligible. Default `noLifeHandPolicy: "all-cards"`: every non-joker card counts. Alternatives: `"unmatched-only"`. A per-round cap is available (`maxRoundPenalty: null` = no cap).
- Dropped players keep their drop penalty and are not scored on cards. Players who were removed for an invalid declaration keep their 40.

All amounts are computed by the backend and added to the cumulative score.

## 7. Elimination and game end

- When cumulative score is **≥ 201** (`eliminationThreshold: 201`) the player is `ELIMINATED`. History is kept.
- Eliminated players stay in the room as spectators, see no cards, and cannot rejoin active rounds.
- The game ends when exactly one non-eliminated player remains. That player is the winner.
- If several players pass 201 in the same round and none remain, the player with the lowest cumulative score is declared winner (`tieBreak: "lowest-score"`).

## 8. One Card To Win (notification only)

Eligible when, among the player's 13 cards, **12 form a valid arrangement** (one LIFE of 4+ natural cards, every other group 3+, no joker in LIFE, jokers only in normal groups) and **exactly 1 card is stray**.

- The server verifies eligibility before accepting the toggle and re-checks after every hand change; if the hand stops qualifying it is switched off automatically.
- All players see "1 CARD TO WIN!" on that player's seat. No card information is exposed.
- It does not affect scoring and can be turned off by the player.

## 9. Full configuration (defaults)

```json
{
  "cardsPerPlayer": 13,
  "minPlayers": 2,
  "maxPlayers": 5,
  "minGroupSize": 3,
  "lifeMinNatural": 4,
  "eliminationThreshold": 201,
  "firstDropPenalty": 20,
  "middleDropPenalty": 40,
  "invalidDeclarationPenalty": 40,
  "invalidDeclarationPolicy": "remove-declarer",
  "openJokerMode": "rank",
  "openJokerNaturalInOwnRank": false,
  "minNaturalInJokerGroup": 2,
  "jokerInLifeGroup": "extra-only",
  "scoringObjective": "min-points",
  "noLifeHandPolicy": "all-cards",
  "unmatchedJokerValue": 0,
  "maxRoundPenalty": null,
  "cardValues": { "A": 10, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, "J": 10, "Q": 10, "K": 10 },
  "turnTimerSeconds": 60,
  "autoDropAfterTimeouts": 3,
  "reconnectGraceSeconds": 90,
  "reshuffleOnEmpty": true,
  "tieBreak": "lowest-score"
}
```

Fixed by the product rules and rejected by `resolveConfig` if changed: `cardsPerPlayer` (13), `minGroupSize` (3), `lifeMinNatural` (4), `invalidDeclarationPenalty` (40). Unknown keys are rejected. `jokerInLifeGroup` and `openJokerMode` currently support only their single documented value.

The number of decks is fixed when the game starts (1 for two players, 2 for three to five) and does not change as players are eliminated.
