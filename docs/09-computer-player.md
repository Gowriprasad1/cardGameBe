# Single player: playing against "mawa"

A player alone can press **Play vs mawa (computer)** in the lobby. A room is
created with the player and **mawa**, the computer player, and the game starts
at once (SET Game or Indian Rummy, with the chosen points limit).

## The name

The computer player is always called **mawa**. Nobody can change it, and no
person can sign in as "mawa" (any capitalisation): the server refuses it with
`NAME_RESERVED`. Each solo room gets its own computer user, marked `is_bot` in
the `users` table (migration `004_computer_player`); its sign-in token is random
and never handed out, so nobody can play as mawa.

## No advantage for either side

- **Same information as a person.** mawa decides from exactly what a person in
  its seat can see: its own 13 or 14 cards, the top card of the open pile, the
  face-up joker number, the settings, the number of decks, its own score and
  turns. It never reads anybody else's cards or the closed pile. This boundary
  is one function, `fairInput()` in `backend/src/bots/bot-driver.service.js`,
  and a test checks that nothing else gets through.
- **Same rules and timer.** Every move mawa makes goes through the same server
  path as a person's move (`gameSessions.perform`), with the same checks, the
  same turn timer and the same scoring. The server shuffles and deals for
  everyone the same way.
- **No shortcuts.** mawa cannot see the next card, cannot undo, and gets no
  extra time.

## How mawa plays (like a sensible person)

- It **thinks for a moment** before each move: about 1.5 to 3.5 seconds before
  picking, 1 to 2 seconds before throwing a card, 3 to 7 seconds before
  submitting after someone's show.
- It **takes the open card only when it clearly helps**, otherwise it draws
  from the closed pile.
- It **throws away the card that hurts its hand most**: it keeps pairs, cards
  close in a sequence (Rummy) and jokers, and throws loose high cards first.
- It **declares as soon as its hand is complete**, and in SET presses
  **1 CARD TO WIN** when its hand is waiting for one card.
- With a **hopeless first hand** it sometimes drops (first drop), but never
  when that drop alone would put it out of the game.
- After somebody's valid show it **arranges its cards and submits**.

Its thinking runs on its own thread (`backend/src/bots/mawa-worker.js`), so a
long think never slows down other games on the server.

## Settings

- `BOT_DELAY_SCALE` (backend): 1 = human-like pauses (default), 0 = instant (tests).
