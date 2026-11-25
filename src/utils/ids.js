'use strict';

const crypto = require('node:crypto');

/** No 0/O/1/I so codes are easy to read out loud. */
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  return code;
}

/** Opaque session token for guests (the browser keeps it, we keep only its hash). */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { generateRoomCode, generateToken, hashToken, ROOM_ALPHABET };
