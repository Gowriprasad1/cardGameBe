'use strict';

const { appError } = require('../constants/errors');

/**
 * Tiny schema validator (no dependency). Unknown keys are dropped, so a client
 * can never smuggle extra fields into a service.
 *
 * rule = { type: 'string'|'boolean'|'enum'|'array', optional?, default?, ... }
 */

function fail(field, reason) {
  throw appError('VALIDATION_FAILED', { field, reason });
}

function checkValue(field, rule, value) {
  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') fail(field, 'must be a string');
      let v = rule.trim === false ? value : value.trim();
      if (rule.upper) v = v.toUpperCase();
      if (rule.min !== undefined && v.length < rule.min) fail(field, `must be at least ${rule.min} characters`);
      if (rule.max !== undefined && v.length > rule.max) fail(field, `must be at most ${rule.max} characters`);
      if (rule.pattern && !rule.pattern.test(v)) fail(field, 'has an invalid format');
      return v;
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail(field, 'must be true or false');
      return value;
    case 'enum':
      if (!rule.values.includes(value)) fail(field, `must be one of ${rule.values.join(', ')}`);
      return value;
    case 'array': {
      if (!Array.isArray(value)) fail(field, 'must be a list');
      if (rule.max !== undefined && value.length > rule.max) fail(field, `must have at most ${rule.max} items`);
      return value.map((item, i) => checkValue(`${field}[${i}]`, rule.items, item));
    }
    default:
      throw new Error(`Unknown rule type ${rule.type}`);
  }
}

/**
 * @param {Object<string, object>} schema
 * @param {unknown} input
 */
function validate(schema, input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) fail('body', 'must be an object');
  const out = {};
  for (const [field, rule] of Object.entries(schema)) {
    const value = input[field];
    if (value === undefined || value === null) {
      if (rule.default !== undefined) out[field] = rule.default;
      else if (!rule.optional) fail(field, 'is required');
      continue;
    }
    out[field] = checkValue(field, rule, value);
  }
  return out;
}

module.exports = { validate };
