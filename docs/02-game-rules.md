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
| B | LIFE (mandatory) | At least one group of **exactly 4 natural** cards of the same rank. A joker never counts toward LIFE, and a fifth card of that rank cannot join the LIFE (`lifeRule: "exactly"`). A group of 5 or more of one rank is still a valid ordinary set. *This replaces the original line "8,8,8,8,8 = LIFE"; set `lifeRule: "at-least"` to bring the old behaviour back.* |
| C1 | Printed joker | Always a wildcard in normal groups. |
| C2 | **Open Joker** | The revealed card's **rank** is the Open Joker rank. Every card of that rank is a wildcard (`openJokerMode: "rank"`), exactly like a printed joker. They are never natural, so they cannot form or complete LIFE. See the open question below. |
| C3 | **Joker in groups** | Jokers only work once the hand has a LIFE (see section 6). With a LIFE, a normal group needs at least **1 natural** card (`minNaturalInJokerGroup: 1`): `5,5,Joker` and `K,Joker,Joker` are valid sets. Jokers alone are not a group. *(Earlier default was 2 natural cards; set `minNaturalInJokerGroup: 2` to restore it.)* |
| C4 | **Joker in a LIFE group** | A group with exactly 4 natural cards is LIFE. Any extra joker placed in it is allowed as a filler but is not counted toward LIFE (`jokerInLifeGroup: "extra-only"`). |
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
3. At least one LIFE (exactly 4 natural cards of one rank in one group).
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

## 6. Scoring (counting the points)

Card values (configurable): 2–10 face value, J/Q/K/A = 10.

After a valid declaration each other player still in the round is counted. **Only cards that are not in a valid set count**; cards inside valid sets are worth 0. The counter always finds the best grouping for the player (fewest points left, `scoringObjective: "min-points"`).

**What the LIFE is for.** The LIFE decides whether jokers work:

- **With a LIFE** (exactly 4 natural cards of one rank) jokers are usable: one natural card plus two jokers is a valid set, a joker next to a pair is a set, and so on. Jokers used in groups count 0.
- **Without a LIFE** the jokers cannot be used. The natural cards still form their valid sets and only the cards outside those sets count. The jokers count **only when every natural card is in a valid set**: then each joker counts `deadJokerValue` (2 points), e.g. four sets + a joker = 2. If any natural card is left loose, only the loose cards count and the jokers count 0, e.g. three sets + 5,5 + two jokers = 10. A card of the Open Joker number is a joker too. Five or six cards of one number (two decks) still contain a LIFE: four of them are the LIFE and the extras can join another set. (`noLifeHandPolicy: "unmatched-only"`. The old "count every card of a no-LIFE hand" is still available as `"all-cards"`.)

Examples (all tested):

| Hand | Count |
|---|---|
| Four valid sets of three + one 8, no LIFE | **8** (the sets do not count) |
| Four valid sets of three + one joker, no LIFE | **2** (the joker cannot be used without a LIFE) |
| LIFE of four, one set of three, two jokers, and 2, K, J, Q | **22**: the jokers join the K as a set, 2 + J + Q count |
| Five 9s, three 6s, five 2s | **2**: LIFE of four 2s, the five 9s as a normal set, one 2 left |

- Dropped players keep their drop penalty and are not counted on cards. Players removed for an invalid declaration keep their 40.
- A per-round cap is available (`maxRoundPenalty: null` = no cap).

All amounts are computed by the backend and added to the cumulative score.

## 7. Elimination and game end

- When cumulative score reaches or exceeds the room's limit the player is `ELIMINATED`. **The host chooses the limit when creating the room: 101, 201 (standard, default) or 301** (`eliminationThreshold`). It cannot change once the room exists. History is kept.
- Eliminated players stay in the room as spectators, see no cards, and cannot rejoin active rounds.
- The game ends when exactly one non-eliminated player remains. That player is the winner.
- If several players pass 201 in the same round and none remain, the player with the lowest cumulative score is declared winner (`tieBreak: "lowest-score"`).

## 8. One Card To Win (notification only)

The player is **waiting for one card**. The button is enabled when the player's 13 cards cannot be declared yet, but there is a card that, once drawn, lets them discard one card and declare a valid hand (a LIFE of exactly 4 natural cards, every other group of 3 or more, no joker in the LIFE).

Examples (all verified by tests):

- **Waiting for a LIFE.** 6,6,6 4,4,4 8,8,8 K,K and two 3s, with 3 as the open joker: drawing a 6, 4 or 8 makes the LIFE, K,K plus an open-joker 3 is a set, the spare 3 is thrown away.
- **Sets only.** 4,4,4 5,5,5 6,6,6 7,7,7 and a lone 9: drawing a fourth 4, 5, 6 or 7 makes the LIFE and the 9 is thrown away.
- **Almost there.** 7,7,7,7 8,8,8,8 9,9,9,9 and a K: drawing a 7, 8 or 9 (or a joker) and throwing away the K.

Details:

- A hand that can already be declared does not qualify (declare instead).
- Only cards that can still exist count: a rank is skipped when the hand already holds every copy of it, and printed jokers only count while the hand holds fewer than the decks contain.
- The server decides. It sends each player a private `oneCardEligible` flag, accepts the toggle only when it is true, and switches the notification off by itself when a discard breaks the hand.
- All players see "1 CARD TO WIN!" on that player's seat. No card information is exposed (not even which card is awaited).
- It does not affect scoring and can be turned off by the player.

## 8b. Printed jokers on the open pile

A printed joker that is thrown onto the open pile **cannot be taken** by the next player (the server answers `JOKER_NOT_PICKABLE`, and the view says `discardPickable: false`). A card of the open-joker number on the open pile **can** be taken. The closed pile is always available.

## 9. Full configuration (defaults)

```json
{
  "cardsPerPlayer": 13,
  "minPlayers": 2,
  "maxPlayers": 5,
  "minGroupSize": 3,
  "lifeMinNatural": 4,
  "lifeRule": "exactly",
  "eliminationThreshold": 201,
  "firstDropPenalty": 20,
  "middleDropPenalty": 40,
  "invalidDeclarationPenalty": 40,
  "invalidDeclarationPolicy": "remove-declarer",
  "openJokerMode": "rank",
  "openJokerNaturalInOwnRank": false,
  "minNaturalInJokerGroup": 1,
  "jokerInLifeGroup": "extra-only",
  "scoringObjective": "min-points",
  "noLifeHandPolicy": "unmatched-only",
  "unmatchedJokerValue": 0,
  "deadJokerValue": 2,
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
