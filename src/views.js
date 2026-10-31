'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT_DIR } = require('./config');

function readView(name) {
  const read = (file) => fs.readFileSync(path.join(ROOT_DIR, 'views', file), 'utf8');
  return read(name)
    .replace('{{ head }}', () => read('partials/head.html').trim())
    .replace('{{ wordmark }}', () => read('partials/wordmark.html').trim());
}

function readAsset(name) {
  return fs.readFileSync(path.join(ROOT_DIR, 'public', name), 'utf8');
}

const LOGIN_PAGE = readView('index.html');

const DASHBOARD_PAGE = readView('dashboard.html');

const TEXT_PAGE = readView('text.html');

const LINKS_PAGE = readView('links.html');

const SETTINGS_PAGE = readView('settings.html');

const PIN_PAGE = readView('pin.html');

const SETUP_PAGE = readView('setup.html');

const TWO_FACTOR_PAGE = readView('two-factor.html');

const MESSAGE_PAGE = readView('message.html');

const ANALYTICS_PAGE = readView('analytics.html');

const LINK_PAGE = readView('link.html');

const SIDEBAR = readView('sidebar.html').trimEnd();

const ASSETS = new Map([
  ['/charts.js', { type: 'text/javascript; charset=utf-8', body: readAsset('charts.js') }],
  ['/dashboard.js', { type: 'text/javascript; charset=utf-8', body: readAsset('dashboard.js') }],
  ['/favicon.svg', { type: 'image/svg+xml', body: readAsset('favicon.svg') }],
  ['/links.js', { type: 'text/javascript; charset=utf-8', body: readAsset('links.js') }],
  ['/login.js', { type: 'text/javascript; charset=utf-8', body: readAsset('login.js') }],
  ['/styles.css', { type: 'text/css; charset=utf-8', body: readAsset('styles.css') }],
  ['/text.js', { type: 'text/javascript; charset=utf-8', body: readAsset('text.js') }],
]);

function renderTemplate(template, values) {
  return template.replace(/\{\{ (\w+) \}\}/g, (_, name) => values[name] ?? '');
}

module.exports = {
  ANALYTICS_PAGE,
  ASSETS,
  DASHBOARD_PAGE,
  LINKS_PAGE,
  LINK_PAGE,
  LOGIN_PAGE,
  MESSAGE_PAGE,
  PIN_PAGE,
  SETTINGS_PAGE,
  SETUP_PAGE,
  SIDEBAR,
  TEXT_PAGE,
  TWO_FACTOR_PAGE,
  renderTemplate,
};
