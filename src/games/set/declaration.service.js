'use strict';

const { validateGroup } = require('./set-validation.service');

/**
 * Validate a declaration made by a player. Pure function: it never trusts the
 * client, it only checks the proposed grouping against the server-held hand.
 *
 * Checks (spec section 8):
 *  1. exactly cardsPerPlayer (13) cards in the hand
 *  2. every submitted card id is in the hand           (UNKNOWN_CARD)
 *  3. no card used twice                               (DUPLICATE_CARD)
 *  4. every hand card is placed in a group             (MISSING_CARDS)
 *  5. every group has 3+ cards and is a valid group    (INVALID_GROUP)
 *  6. jokers only fill normal groups correctly         (INVALID_GROUP)
 *  7. at least one LIFE: 4+ natural same-rank cards    (NO_LIFE)
 *
 * @param {{hand: import('./deck.service').Card[], groups: string[][], ctx: object}} args
 * @returns {{valid: boolean, errors: {code: string, message: string, groupIndex?: number}[], groups: object[]}}
 */
function validateDeclaration({ hand, groups, ctx }) {
  const errors = [];
  const add = (code, message, extra = {}) => errors.push({ code, message, ...extra });

  if (hand.length !== ctx.config.cardsPerPlayer) {
    add('WRONG_CARD_COUNT', `Declaration needs exactly ${ctx.config.cardsPerPlayer} cards, hand has ${hand.length}`);
    return { valid: false, errors, groups: [] };
  }
  if (!Array.isArray(groups) || groups.some((g) => !Array.isArray(g))) {
    add('MALFORMED_GROUPS', 'Groups must be a list of card id lists');
    return { valid: false, errors, groups: [] };
  }

  const byId = new Map(hand.map((c) => [c.id, c]));
  const used = new Set();
  const analyses = [];

  groups.forEach((ids, groupIndex) => {
    if (ids.length === 0) {
      add('EMPTY_GROUP', 'A group cannot be empty', { groupIndex });
      return;
    }
    const cards = [];
    for (const id of ids) {
      const card = byId.get(id);
      if (!card) {
        add('UNKNOWN_CARD', `Card ${String(id)} is not in your hand`, { groupIndex });
        continue;
      }
      if (used.has(id)) {
        add('DUPLICATE_CARD', `Card ${id} is used more than once`, { groupIndex });
        continue;
      }
      used.add(id);
      cards.push(card);
    }
    const analysis = validateGroup(cards, ctx);
    analyses.push({ groupIndex, cardIds: cards.map((c) => c.id), ...analysis });
    if (!analysis.valid) {
      add('INVALID_GROUP', `Group ${groupIndex + 1} is not valid (${analysis.reason})`, { groupIndex });
    }
  });

  const missing = hand.filter((c) => !used.has(c.id)).map((c) => c.id);
  if (missing.length > 0) add('MISSING_CARDS', `${missing.length} card(s) are not in any group`, { cardIds: missing });

  if (!analyses.some((a) => a.valid && a.isLife)) {
    add('NO_LIFE', 'You need at least one LIFE: 4 or more natural cards of the same rank');
  }

  return { valid: errors.length === 0, errors, groups: analyses };
}

module.exports = { validateDeclaration };
