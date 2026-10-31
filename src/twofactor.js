'use strict';

const crypto = require('node:crypto');
const { hashToken } = require('./auth');
const { ENROLLMENT_MS, PENDING_LOGIN_MS, RECOVERY_CODE_COUNT, TOTP_DIGITS, TOTP_DRIFT_STEPS, TOTP_STEP_SECONDS } = require('./config');
const { deleteRecoveryCode, recordTotpStep } = require('./db');
const { nowSeconds } = require('./format');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const SECRET_BYTES = 20;

const RECOVERY_CODE_BYTES = 10;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of text) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

function codeForStep(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function cleanCode(input) {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function matchingStep(secret, input) {
  const given = Buffer.from(cleanCode(input));
  const current = Math.floor(nowSeconds() / TOTP_STEP_SECONDS);
  let matched = null;
  for (let step = current - TOTP_DRIFT_STEPS; step <= current + TOTP_DRIFT_STEPS; step += 1) {
    const expected = Buffer.from(codeForStep(secret, step));
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) matched = step;
  }
  return matched;
}

function otpauthUrl(username, secret) {
  const label = encodeURIComponent(`Shortify:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Shortify&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

function generateRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => base32Encode(crypto.randomBytes(RECOVERY_CODE_BYTES)).match(/.{4}/g).join('-'));
}

function hashRecoveryCode(code) {
  return hashToken(cleanCode(code));
}

function secondFactorMatches(user, input) {
  const step = matchingStep(user.totp_secret, input);
  if (step !== null) return recordTotpStep.run(step, user.id, step).changes === 1;
  return deleteRecoveryCode.run(user.id, hashRecoveryCode(input)).changes === 1;
}

function createExpiringStore(lifetimeMs) {
  const entries = new Map();
  return {
    set(key, value) {
      const now = Date.now();
      for (const [existing, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(existing);
      }
      entries.set(key, { ...value, expiresAt: now + lifetimeMs });
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt > Date.now()) return entry;
      entries.delete(key);
      return undefined;
    },
    delete(key) {
      entries.delete(key);
    },
    deleteWhere(matches) {
      for (const [key, entry] of entries) {
        if (matches(entry)) entries.delete(key);
      }
    },
  };
}

const pendingLogins = createExpiringStore(PENDING_LOGIN_MS);

const enrollments = createExpiringStore(ENROLLMENT_MS);

function forgetPendingLogins(userId) {
  pendingLogins.deleteWhere((entry) => entry.userId === userId);
}

module.exports = {
  enrollments,
  forgetPendingLogins,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  matchingStep,
  otpauthUrl,
  pendingLogins,
  secondFactorMatches,
};
