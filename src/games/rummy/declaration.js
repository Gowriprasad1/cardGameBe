'use strict';

const { describe, evaluateInfos } = require('./melds');

/**
 * Check a "show". The groups come from the player; the hand is the server's.
 *
 *  1. exactly 13 cards, each owned by the player, none used twice, none missing
 *  2. every group is a valid pure sequence, sequence or set (3+ cards)
 *  3. at least one PURE sequence
 *  4. at least two sequences in total (the pure one counts as one)
 *
 * @returns {{valid: boolean, errors: {code: string, message: string, groupIndex?: number}[], groups: object[]}}
 */
function validateDeclaration({ hand, groups, ctx }) {
  const errors = [];
  const add = (code, message, extra = {}) => errors.push({ code, message, ...extra });

  if (hand.length !== ctx.config.cardsPerPlayer) {
    add('WRONG_CARD_COUNT', `A show needs exactly ${ctx.config.cardsPerPlayer} cards, hand has ${hand.length}`);
    return { valid: false, errors, groups: [] };
  }
  if (!Array.isArray(groups) || groups.some((g) => !Array.isArray(g))) {
    add('MALFORMED_GROUPS', 'Groups must be a list of card id lists');
    return { valid: false, errors, groups: [] };
  }

  const byId = new Map(hand.map((c) => [c.id, c]));
  const used = new Set();
  const analysed = [];

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
    const kind = evaluateInfos(cards.map((c) => describe(c, ctx)), ctx.config);
    analysed.push({ groupIndex, cardIds: cards.map((c) => c.id), kind, isLife: false });
    if (!kind) add('INVALID_GROUP', `Group ${groupIndex + 1} is not a valid sequence or set`, { groupIndex });
  });

  const missing = hand.filter((c) => !used.has(c.id)).map((c) => c.id);
  if (missing.length > 0) add('MISSING_CARDS', `${missing.length} card(s) are not in any group`, { cardIds: missing });

  const valid = analysed.filter((g) => g.kind);
  if (!valid.some((g) => g.kind === 'pure')) {
    add('NO_PURE_SEQUENCE', 'You need at least one pure sequence (no joker in it)');
  } else if (valid.filter((g) => g.kind === 'pure' || g.kind === 'seq').length < 2) {
    add('NEED_SECOND_SEQUENCE', 'You need a second sequence besides the pure sequence');
  }
  return { valid: errors.length === 0, errors, groups: analysed };
}

module.exports = { validateDeclaration };
