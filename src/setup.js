'use strict';

const crypto = require('node:crypto');
const { clientAddress, csrfToken, csrfValid, hashPassword, loginTries, startSession } = require('./auth');
const { ADMIN_USERNAME, MIN_PASSWORD_LENGTH, PAGE_EXPIRED, USERNAME_PATTERN } = require('./config');
const { countUsers, insertUser } = require('./db');
const { escapeHtml, fieldAria, fieldError, readForm, redirect, sendHtml, sendText } = require('./http');
const { SETUP_PAGE, renderTemplate } = require('./views');

let setupCode = null;

function isSetupPending() {
  return setupCode !== null;
}

async function prepareFirstRun() {
  if (countUsers.get().count > 0) return;
  if (process.env.SHORTIFY_ADMIN_PASSWORD) {
    insertUser.run(ADMIN_USERNAME, await hashPassword(process.env.SHORTIFY_ADMIN_PASSWORD));
    console.log(`Created account "${ADMIN_USERNAME}".`);
    return;
  }
  setupCode = crypto.randomBytes(12).toString('base64url');
  console.log(`Open Shortify in a browser to create your account. Setup code: ${setupCode}`);
}

function renderSetup(req, res, status, { username = '', errors = {} } = {}) {
  const values = {
    csrf_token: csrfToken(req, res),
    username: escapeHtml(username),
    code_aria: fieldAria('code-error', errors.code),
    code_error: fieldError('code-error', errors.code),
    username_aria: fieldAria('username-error', errors.username),
    username_error: fieldError('username-error', errors.username),
    password_aria: fieldAria('password-error', errors.password),
    password_error: fieldError('password-error', errors.password),
    repeat_aria: fieldAria('repeat-error', errors.repeat),
    repeat_error: fieldError('repeat-error', errors.repeat),
  };
  sendHtml(res, status, renderTemplate(SETUP_PAGE, values));
}

function setupCodeMatches(input) {
  const given = crypto.createHash('sha256').update(input).digest();
  const expected = crypto.createHash('sha256').update(setupCode).digest();
  return crypto.timingSafeEqual(given, expected);
}

async function handleSetup(req, res) {
  const form = await readForm(req);
  if (!csrfValid(req, form)) return sendText(res, 403, PAGE_EXPIRED);

  const address = clientAddress(req);
  const username = (form.get('username') || '').trim();
  const password = form.get('password') || '';
  const refuse = (status, errors) => renderSetup(req, res, status, { username, errors });

  if (!loginTries.reserve(address)) return refuse(429, { code: 'Too many tries. Wait 15 minutes, then try again.' });
  if (!setupCodeMatches((form.get('code') || '').trim())) {
    return refuse(401, { code: 'That isn\'t the setup code. Copy it again from the logs.' });
  }
  loginTries.release(address);
  if (!USERNAME_PATTERN.test(username)) return refuse(400, { username: 'Use letters, numbers, dots, hyphens and underscores.' });
  if (password.length < MIN_PASSWORD_LENGTH) return refuse(400, { password: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
  if (password !== form.get('repeat')) return refuse(400, { repeat: 'These passwords don\'t match.' });

  const passwordHash = await hashPassword(password);
  if (!setupCode) return redirect(res, '/');
  setupCode = null;
  const { lastInsertRowid } = insertUser.run(username, passwordHash);
  loginTries.clear(address);
  startSession(req, res, lastInsertRowid, false);
  return redirect(res, '/dashboard');
}

async function routeFirstRun(req, res, pathname) {
  if (pathname !== '/setup') return redirect(res, '/setup');
  if (req.method === 'POST') return handleSetup(req, res);
  return renderSetup(req, res, 200);
}

module.exports = {
  isSetupPending,
  prepareFirstRun,
  routeFirstRun,
};
