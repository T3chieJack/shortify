'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { CSRF_COOKIE, LOCKOUT_MS, MAX_FAILED_LOGINS, MAX_MISSED_LINKS, MAX_PIN_TRIES_PER_LINK, MAX_PIN_TRIES_PER_VISITOR, REMEMBER_SECONDS, SECURE_COOKIES, SESSION_COOKIE, SESSION_SECONDS } = require('./config');
const { deleteExpiredSessions, findSessionUser, getSetting, insertSession } = require('./db');
const { nowSeconds } = require('./format');

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const KEY_BYTES = 64;

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_BYTES, SCRYPT);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function passwordMatches(password, stored) {
  const [salt, key] = stored.split(':').map((part) => Buffer.from(part, 'hex'));
  return crypto.timingSafeEqual(await scrypt(password, salt, KEY_BYTES, SCRYPT), key);
}

function createTryLimiter(maxTries) {
  const failures = new Map();
  return {
    isLocked(key) {
      const entry = failures.get(key);
      if (!entry) return false;
      if (entry.expiresAt <= Date.now()) {
        failures.delete(key);
        return false;
      }
      return entry.count >= maxTries;
    },
    reserve(key) {
      if (this.isLocked(key)) return false;
      const now = Date.now();
      for (const [existing, entry] of failures) {
        if (entry.expiresAt <= now) failures.delete(existing);
      }
      const entry = failures.get(key) || { count: 0 };
      entry.count += 1;
      entry.expiresAt = now + LOCKOUT_MS;
      failures.set(key, entry);
      return true;
    },
    release(key) {
      const entry = failures.get(key);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count <= 0) failures.delete(key);
    },
    clear(key) {
      failures.delete(key);
    },
  };
}

const loginTries = createTryLimiter(MAX_FAILED_LOGINS);

const pinTriesByVisitor = createTryLimiter(MAX_PIN_TRIES_PER_VISITOR);

const pinTriesByLink = createTryLimiter(MAX_PIN_TRIES_PER_LINK);
const missedLinksByVisitor = createTryLimiter(MAX_MISSED_LINKS);

let trustedProxies = new Set((getSetting('trusted_proxies') || '').split(',').filter(Boolean));

function listTrustedProxies() {
  return [...trustedProxies];
}

function setTrustedProxies(addresses) {
  trustedProxies = new Set(addresses);
}

function peerAddress(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function peerIsLoopback(req) {
  const peer = peerAddress(req);
  return peer === '127.0.0.1' || peer === '::1';
}

function peerIsTrusted(req) {
  return peerIsLoopback(req) || trustedProxies.has(peerAddress(req));
}

function clientAddress(req) {
  if (peerIsLoopback(req) && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']).trim();
  if (peerIsTrusted(req) && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',').pop().trim();
  }
  return peerAddress(req);
}

function clientCountry(req) {
  return peerIsTrusted(req) ? req.headers['cf-ipcountry'] : null;
}

function requestIsHttps(req) {
  if (SECURE_COOKIES || req.socket.encrypted) return true;
  return peerIsTrusted(req) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function cookieName(req, name) {
  return requestIsHttps(req) ? `__Host-${name}` : name;
}

function readCookie(req, name) {
  return parseCookies(req)[cookieName(req, name)];
}

function cookieHeader(req, name, value, maxAge) {
  let cookie = `${cookieName(req, name)}=${value}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) cookie += `; Max-Age=${maxAge}`;
  if (requestIsHttps(req)) cookie += '; Secure';
  return cookie;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionUser(req) {
  const token = readCookie(req, SESSION_COOKIE);
  return token ? findSessionUser.get(hashToken(token), nowSeconds()) : undefined;
}

function isLoggedIn(req) {
  return Boolean(sessionUser(req));
}

function startSession(req, res, userId, remember) {
  const token = crypto.randomBytes(32).toString('base64url');
  const lifetime = remember ? REMEMBER_SECONDS : SESSION_SECONDS;
  deleteExpiredSessions.run(nowSeconds());
  insertSession.run(hashToken(token), userId, nowSeconds() + lifetime);
  res.appendHeader('Set-Cookie', cookieHeader(req, SESSION_COOKIE, token, remember ? REMEMBER_SECONDS : undefined));
}

function csrfToken(req, res) {
  const existing = readCookie(req, CSRF_COOKIE);
  if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  res.appendHeader('Set-Cookie', cookieHeader(req, CSRF_COOKIE, token));
  return token;
}

function csrfValid(req, form) {
  const cookie = Buffer.from(readCookie(req, CSRF_COOKIE) || '');
  const token = form.get('csrf_token');
  const field = Buffer.from(typeof token === 'string' ? token : '');
  return cookie.length > 0 && cookie.length === field.length && crypto.timingSafeEqual(cookie, field);
}

module.exports = {
  missedLinksByVisitor,
  clientAddress,
  clientCountry,
  cookieHeader,
  csrfToken,
  csrfValid,
  hashPassword,
  hashToken,
  isLoggedIn,
  listTrustedProxies,
  loginTries,
  passwordMatches,
  peerIsTrusted,
  pinTriesByLink,
  pinTriesByVisitor,
  readCookie,
  requestIsHttps,
  sessionUser,
  setTrustedProxies,
  startSession,
};
