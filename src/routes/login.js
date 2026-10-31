'use strict';

const crypto = require('node:crypto');
const { clientAddress, cookieHeader, csrfToken, csrfValid, hashPassword, hashToken, isLoggedIn, loginTries, passwordMatches, readCookie, startSession, twoFactorTries } = require('../auth');
const { PAGE_EXPIRED, PENDING_LOGIN_MS, SESSION_COOKIE, TWO_FACTOR_COOKIE } = require('../config');
const { analytics, deleteSession, findUser, findUserById } = require('../db');
const { escapeHtml, readForm, redirect, sendHtml, sendText } = require('../http');
const { pendingLogins, secondFactorMatches } = require('../twofactor');
const { LOGIN_PAGE, TWO_FACTOR_PAGE, renderTemplate } = require('../views');

function renderLogin(req, res, status, { message, username } = {}) {
  let html = LOGIN_PAGE.replace('{{ csrf_token }}', () => csrfToken(req, res));
  if (message) html = html.replace(`data-msg="${message}" hidden`, `data-msg="${message}"`);
  if (username) html = html.replace('<input id="username" ', () => `<input id="username" value="${escapeHtml(username)}" `);
  sendHtml(res, status, html);
}

let dummyHash;

async function prepareLogin() {
  dummyHash = await hashPassword(crypto.randomBytes(18).toString('base64url'));
}

async function handleLogin(req, res) {
  const form = await readForm(req);
  if (!csrfValid(req, form)) {
    sendText(res, 403, PAGE_EXPIRED);
    return;
  }

  const address = clientAddress(req);
  const username = (form.get('username') || '').trim();
  if (!loginTries.reserve(address)) {
    renderLogin(req, res, 429, { message: 'locked', username });
    return;
  }

  const user = findUser.get(username);
  const matches = await passwordMatches(form.get('password') || '', user ? user.password_hash : dummyHash);
  if (!user || !matches) {
    analytics.noteSecurity('login_failed');
    renderLogin(req, res, 401, { message: loginTries.isLocked(address) ? 'locked' : 'error', username });
    return;
  }

  loginTries.clear(address);
  const remember = form.get('remember') === '1';
  if (user.totp_secret) {
    const token = crypto.randomBytes(32).toString('base64url');
    pendingLogins.set(hashToken(token), { userId: user.id, remember });
    res.appendHeader('Set-Cookie', cookieHeader(req, TWO_FACTOR_COOKIE, token, PENDING_LOGIN_MS / 1000));
    redirect(res, '/login/2fa');
    return;
  }
  startSession(req, res, user.id, remember);
  redirect(res, '/dashboard');
}

function pendingLoginKey(req) {
  const token = readCookie(req, TWO_FACTOR_COOKIE);
  return token ? hashToken(token) : '';
}

function sendTwoFactorPage(req, res, status, message) {
  const values = {
    csrf_token: csrfToken(req, res),
    code_aria: message ? 'aria-invalid="true" aria-describedby="code-error"' : '',
    message: message ? `<div class="messages" role="alert"><p class="msg msg-alert" id="code-error">${escapeHtml(message)}</p></div>` : '',
  };
  sendHtml(res, status, renderTemplate(TWO_FACTOR_PAGE, values));
}

function renderTwoFactorLogin(req, res) {
  if (isLoggedIn(req)) return redirect(res, '/dashboard');
  if (!pendingLogins.get(pendingLoginKey(req))) return redirect(res, '/');
  return sendTwoFactorPage(req, res, 200);
}

async function handleTwoFactorLogin(req, res) {
  const form = await readForm(req);
  if (!csrfValid(req, form)) return sendText(res, 403, PAGE_EXPIRED);

  const key = pendingLoginKey(req);
  const pending = pendingLogins.get(key);
  const user = pending && findUserById.get(pending.userId);
  if (!user || !user.totp_secret) return renderLogin(req, res, 400, { message: 'expired' });

  if (!twoFactorTries.reserve(user.id)) {
    return sendTwoFactorPage(req, res, 429, 'Too many tries. Wait 15 minutes, then try again.');
  }
  if (!secondFactorMatches(user, form.get('code') || '')) {
    analytics.noteSecurity('login_failed');
    const message = twoFactorTries.isLocked(user.id)
      ? 'Too many tries. Wait 15 minutes, then try again.'
      : 'That code isn\'t right. Check it and try again. If you just used this code, wait for the next one.';
    return sendTwoFactorPage(req, res, 401, message);
  }

  twoFactorTries.release(user.id);
  pendingLogins.delete(key);
  res.appendHeader('Set-Cookie', cookieHeader(req, TWO_FACTOR_COOKIE, '', 0));
  startSession(req, res, user.id, pending.remember);
  return redirect(res, '/dashboard');
}

async function handleLogout(req, res) {
  const form = await readForm(req);
  if (!csrfValid(req, form)) {
    sendText(res, 403, PAGE_EXPIRED);
    return;
  }
  const token = readCookie(req, SESSION_COOKIE);
  if (token) deleteSession.run(hashToken(token));
  res.appendHeader('Set-Cookie', cookieHeader(req, SESSION_COOKIE, '', 0));
  redirect(res, '/');
}

module.exports = {
  handleLogin,
  handleLogout,
  handleTwoFactorLogin,
  prepareLogin,
  renderLogin,
  renderTwoFactorLogin,
};
