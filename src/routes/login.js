'use strict';

const crypto = require('node:crypto');
const { clientAddress, cookieHeader, csrfToken, csrfValid, hashPassword, hashToken, loginTries, passwordMatches, readCookie, startSession } = require('../auth');
const { PAGE_EXPIRED, SESSION_COOKIE } = require('../config');
const { analytics, deleteSession, findUser } = require('../db');
const { escapeHtml, readForm, redirect, sendHtml, sendText } = require('../http');
const { LOGIN_PAGE } = require('../views');

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
  startSession(req, res, user.id, form.get('remember') === '1');
  redirect(res, '/dashboard');
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
  prepareLogin,
  renderLogin,
};
