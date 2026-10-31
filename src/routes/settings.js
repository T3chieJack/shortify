'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const qr = require('../qr');
const tunnel = require('../tunnel');
const { clientAddress, csrfToken, csrfValid, hashPassword, hashToken, isLoggedIn, listTrustedProxies, loginTries, passwordMatches, readCookie, requestIsHttps, sessionUser, setTrustedProxies, twoFactorTries } = require('../auth');
const { APP_VERSION, CONNECTION_LABELS, DATA_DIR, DAY_SECONDS, DOMAIN_CHECK_TIMEOUT_MS, MAX_API_KEY_NAME_LENGTH, MIN_PASSWORD_LENGTH, PAGE_EXPIRED, PORT, RETENTION_LABELS, SESSION_COOKIE, SETTINGS_NOTICES, UPDATE_SCHEDULE_LABELS } = require('../config');
const { INSTANCE_ID, TLS_CERT_PATH, TLS_KEY_PATH, analytics, countDomainLinks, countRecoveryCodes, db, defaultDomainId, deleteApiKey, deleteDomain, deleteOtherSessions, disableTwoFactor, enableTwoFactor, findDomain, findDomainByName, getSetting, insertApiKey, insertDomain, listApiKeys, listDomains, recordDomainCheck, removeSetting, replaceRecoveryCodes, storageTotals, updatePassword, writeSetting } = require('../db');
const { dayString, detailRow, formatBytes, formatLongDate, nowSeconds, optionsHtml, plural } = require('../format');
const { escapeHtml, fieldAria, fieldError, readForm, redirect, sendHtml, sendText } = require('../http');
const { parseCertificate, readCertificate, startHttps, stopHttps } = require('../https-server');
const { renderSidebar } = require('../layout');
const { enrollments, forgetPendingLogins, generateRecoveryCodes, generateSecret, hashRecoveryCode, matchingStep, otpauthUrl, secondFactorMatches } = require('../twofactor');
const { currentSchedule, readStatus, requestAction } = require('../updates');
const { timeZoneIsValid } = require('./analytics');
const { SETTINGS_PAGE, renderTemplate } = require('../views');

const TOO_MANY_TRIES = 'Too many tries. Wait 15 minutes, then try again.';

const WRONG_CODE = 'That code isn\'t right. If you just used this code, wait for the next one.';

function domainStatusHtml(domain) {
  if (!domain.checked_at) return '<span class="item-status">Not checked yet</span>';
  if (domain.check_error) return `<span class="item-status item-status-bad">${escapeHtml(domain.check_error)}</span>`;
  return '<span class="item-status item-status-good">Reaches this server</span>';
}

function domainListHtml(csrf) {
  const domains = listDomains.all();
  if (domains.length === 0) return '<p class="empty list-empty">No domains yet. Until you add one, short links use the address you opened Shortify on.</p>';
  const defaultId = defaultDomainId();
  const items = domains.map((domain) => {
    const isDefault = domain.id === defaultId;
    return `<li class="item-row">
                <div class="item-info">
                  <p class="item-name">${domain.https ? 'https' : 'http'}://${escapeHtml(domain.hostname)}${isDefault ? ' <span class="item-default">Default</span>' : ''}</p>
                  <p class="item-meta">${CONNECTION_LABELS[domain.connection]}, ${plural(domain.link_count, 'link')}</p>
                  ${domainStatusHtml(domain)}
                </div>
                <form class="item-actions" method="post">
                  <input type="hidden" name="csrf_token" value="${csrf}">
                  <input type="hidden" name="id" value="${domain.id}">
                  <button class="button-text" type="submit" formaction="/settings/domains/check">Check</button>
                  <button class="button-text" type="submit" formaction="/settings/domains/default"${isDefault ? ' name="clear" value="1"' : ''}>${isDefault ? 'Stop using as default' : 'Make default'}</button>
                  <button class="button-text button-text-danger" type="submit" formaction="/settings/domains/remove">Remove</button>
                </form>
              </li>`;
  });
  return `<ul class="item-list">
              ${items.join('\n              ')}
            </ul>`;
}

function tunnelPanelHtml(csrf, { state, error }, tokenError) {
  if (!tunnel.isInstalled()) {
    return `<p class="status-line status-line-off">Not available in this build</p>
            <p class="card-intro">The cloudflared program isn't installed in this container yet, so a tunnel can't be started from here. Domains and your own reverse proxy still work.</p>`;
  }
  const labels = {
    off: ['Not set up', 'off'],
    connecting: ['Connecting', 'off'],
    connected: ['Connected', 'good'],
    failed: ['Could not connect', 'bad'],
  };
  const [label, tone] = labels[state];
  const detail = error ? `<p class="field-error">${escapeHtml(error)}</p>` : '';
  const remove = state === 'off' ? '' : `<form class="danger-action" method="post" action="/settings/tunnel/remove">
              <input type="hidden" name="csrf_token" value="${csrf}">
              <button class="button-text button-text-danger" type="submit">Disconnect and remove token</button>
              <p class="field-hint">If you're using this page through the tunnel, you'll lose it. You can still reach Shortify on its local address.</p>
            </form>`;
  return `<p class="status-line status-line-${tone}">${label}</p>
            ${detail}
            <p class="card-intro">Reach Shortify from anywhere without opening a port. In Cloudflare Zero Trust, create a tunnel and copy its token. Then add a public hostname there with the service <code>http://localhost:${PORT}</code>, and add the same hostname under Domains.</p>
            <form method="post" action="/settings/tunnel">
              <input type="hidden" name="csrf_token" value="${csrf}">
              <div class="field">
                <label for="token">${state === 'off' ? 'Tunnel token' : 'Replace tunnel token'}</label>
                <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" ${fieldAria('token-error', tokenError)}>
                <p class="field-hint">Stored on this server and never shown again.</p>
                ${fieldError('token-error', tokenError)}
              </div>
              <button class="button button-small" type="submit">Save and connect</button>
            </form>
            ${remove}`;
}

function confirmRemoveDomainHtml(domain, csrf) {
  const count = countDomainLinks.get(domain.id).count;
  const name = escapeHtml(domain.hostname);
  const moved = count ? `<p>${plural(count, 'link')} on ${name} will show whichever address you're using instead. They still work wherever this server can be reached.</p>` : '';
  return `<section class="card confirm-card">
        <h2>Remove ${name}?</h2>
        ${moved}
        <p>This only removes it from Shortify. Your DNS and any tunnel route for it stay as they are.</p>
        <form class="confirm-actions" method="post" action="/settings/domains/remove">
          <input type="hidden" name="csrf_token" value="${csrf}">
          <input type="hidden" name="id" value="${domain.id}">
          <input type="hidden" name="confirm" value="1">
          <button class="button button-small button-danger" type="submit">Remove domain</button>
          <a class="button-text" href="/settings">Keep it</a>
        </form>
      </section>`;
}

async function storageHtml() {
  const { files, bytes } = storageTotals.get();
  const database = await fs.promises.stat(path.join(DATA_DIR, 'shortify.db')).then(({ size }) => size).catch(() => 0);
  const { count: events, oldest } = analytics.storedEvents();
  const rows = [
    ['Shared files', `${plural(files, 'file')}, ${formatBytes(bytes)}`],
    ['Database', formatBytes(database)],
    ['Detailed stats', oldest ? `${plural(events, 'click')} since ${formatLongDate(new Date(oldest * 1000))}` : 'None stored'],
  ];
  try {
    const disk = await fs.promises.statfs(DATA_DIR);
    rows.push(['Free disk space', formatBytes(disk.bavail * disk.bsize)]);
  } catch {
  }
  return rows.map(([label, value]) => detailRow(label, value)).join('\n              ');
}

function httpsPanelHtml(csrf, certError) {
  const stored = readCertificate();
  const redirectOn = getSetting('https_redirect') === '1';
  let status = `<p class="status-line status-line-off">Off</p>
            <p class="card-intro">Shortify answers over plain HTTP, which is fine on a network you trust. For anything public, use HTTPS. Cloudflare Tunnel or your own reverse proxy gives you that without a certificate here. Otherwise, paste one below.</p>`;
  if (stored) {
    const certificate = new crypto.X509Certificate(stored.cert);
    const expiry = new Date(certificate.validTo);
    const daysLeft = Math.floor((expiry.getTime() - Date.now()) / (DAY_SECONDS * 1000));
    const names = (certificate.subjectAltName || certificate.subject).replace(/DNS:|IP Address:|CN=/g, '');
    const expired = daysLeft < 0;
    status = `<p class="status-line ${expired ? 'status-line-bad' : 'status-line-good'}">${expired ? 'Certificate expired' : 'On'}</p>
            <dl class="details">
              ${detailRow('Covers', escapeHtml(names))}
              ${detailRow(expired ? 'Expired' : 'Expires', `${escapeHtml(formatLongDate(expiry))}${expired ? '' : `, in ${plural(daysLeft, 'day')}`}`)}
            </dl>`;
  }
  const remove = stored ? `<form class="danger-action" method="post" action="/settings/https/remove">
              <input type="hidden" name="csrf_token" value="${csrf}">
              <button class="button-text button-text-danger" type="submit">Remove certificate and turn off HTTPS</button>
            </form>` : '';
  return `${status}
            <form class="https-form" method="post" action="/settings/https">
              <input type="hidden" name="csrf_token" value="${csrf}">
              <div class="field">
                <label for="https-cert">${stored ? 'Replace certificate' : 'Certificate'}</label>
                <textarea id="https-cert" name="cert" rows="3" autocomplete="off" spellcheck="false" ${fieldAria('https-error', certError)}></textarea>
                <p class="field-hint">Include any intermediate certificates after your own.</p>
              </div>
              <div class="field">
                <label for="https-key">Private key</label>
                <textarea id="https-key" name="key" rows="3" autocomplete="off" spellcheck="false"></textarea>
                <p class="field-hint">Stored on this server and never shown again.</p>
                ${fieldError('https-error', certError)}
              </div>
              <label class="check-row">
                <input type="checkbox" name="redirect" value="1"${redirectOn ? ' checked' : ''}>
                <span>Send HTTP visitors to HTTPS</span>
              </label>
              <button class="button button-small" type="submit">Save HTTPS settings</button>
            </form>
            ${remove}`;
}

function apiSectionHtml(req, csrf, newKey, nameError) {
  if (!analytics.isEnabled()) return '';
  const keys = listApiKeys.all();
  const list = keys.length ? `<ul class="item-list">
                ${keys.map((key) => `<li class="item-row">
                  <div class="item-info">
                    <p class="item-name">${escapeHtml(key.name)}</p>
                    <p class="item-meta">Created ${formatLongDate(new Date(key.created_at * 1000))}, ${key.last_used_at ? `last used ${formatLongDate(new Date(key.last_used_at * 1000))}` : 'never used'}</p>
                  </div>
                  <form class="item-actions" method="post" action="/settings/api/remove">
                    <input type="hidden" name="csrf_token" value="${csrf}">
                    <input type="hidden" name="id" value="${key.id}">
                    <button class="button-text button-text-danger" type="submit">Revoke</button>
                  </form>
                </li>`).join('\n                ')}
              </ul>` : '';
  const shown = newKey ? `<div class="field new-key" role="status">
                <label for="new-key">Your new key. Copy it now, because it can't be shown again.</label>
                <input id="new-key" type="text" readonly value="${escapeHtml(newKey)}">
              </div>` : '';
  const base = `${requestIsHttps(req) ? 'https' : 'http'}://${escapeHtml(req.headers.host || '')}`;
  return `<div class="card-section" id="api">
              <h3>API keys</h3>
              <p>Create links from scripts and shortcuts. A key can create, list and delete links, so treat it like a password.</p>
              ${shown}
              ${list}
              <form method="post" action="/settings/api">
                <input type="hidden" name="csrf_token" value="${csrf}">
                <div class="field">
                  <label for="key-name">Name for a new key</label>
                  <input id="key-name" name="name" type="text" maxlength="${MAX_API_KEY_NAME_LENGTH}" autocomplete="off" placeholder="Phone shortcut" ${fieldAria('key-name-error', nameError)}>
                  ${fieldError('key-name-error', nameError)}
                </div>
                <button class="button button-small button-quiet" type="submit">Create key</button>
              </form>
              <p class="api-example"><code>curl -X POST ${base}/api/links -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -d '{"url":"https://example.com","slug":"hello"}'</code></p>
            </div>`;
}

function confirmClearStatsHtml(csrf) {
  return `<section class="card confirm-card">
        <h2>Delete detailed stats?</h2>
        <p>This removes every recorded visit: referrers, devices, countries, visitor counts and the rest. Your links and their click counts stay. You can't undo this.</p>
        <form class="confirm-actions" method="post" action="/settings/advanced/clear">
          <input type="hidden" name="csrf_token" value="${csrf}">
          <input type="hidden" name="confirm" value="1">
          <button class="button button-small button-danger" type="submit">Delete detailed stats</button>
          <a class="button-text" href="/settings#advanced">Keep them</a>
        </form>
      </section>`;
}

function updatesPanelHtml(csrf) {
  const version = detailRow('This version', escapeHtml(APP_VERSION));
  const status = readStatus();
  if (!status) {
    return `<dl class="details">
              ${version}
            </dl>
            <p class="card-intro">To update from here, add the optional updater container to your Compose file. The README's Updates section shows how. Until then, run <code>docker compose pull</code> and <code>docker compose up -d</code> on the server.</p>`;
  }
  const working = status.state === 'updating' || status.state === 'checking';
  const failed = status.state === 'failed';
  const failure = failed ? `<p class="field-error">${escapeHtml(status.message)}</p>` : '';
  let summary = 'Not checked yet';
  if (failed) summary = 'The last attempt failed, so nothing changed';
  else if (status.state === 'updating') summary = 'Updating now';
  else if (status.state === 'checking') summary = 'Checking now';
  else if (status.updateAvailable) summary = status.latestVersion ? `Version ${escapeHtml(status.latestVersion)} is available` : 'A new version is available';
  else if (status.checkedAt) summary = 'Up to date';
  const checked = status.checkedAt ? detailRow('Last checked', escapeHtml(formatLongDate(new Date(status.checkedAt)))) : '';
  const { schedule, hour } = currentSchedule();
  const hours = Object.fromEntries(Array.from({ length: 24 }, (_, value) => [value, `${String(value).padStart(2, '0')}:00`]));
  const actions = working ? '' : `<form class="confirm-actions" method="post">
              <input type="hidden" name="csrf_token" value="${csrf}">
              <button class="button button-small${status.updateAvailable ? '' : ' button-quiet'}" type="submit" formaction="/settings/updates/run">Update now</button>
              <button class="button-text" type="submit" formaction="/settings/updates/check">Check for updates</button>
            </form>`;
  return `<p class="status-line ${failed ? 'status-line-bad' : status.updateAvailable ? 'status-line-good' : 'status-line-off'}">${summary}</p>
            ${failure}
            <dl class="details">
              ${version}
              ${checked}
            </dl>
            ${actions}
            <form class="backup-form settings-form" method="post" action="/settings/updates/schedule">
              <input type="hidden" name="csrf_token" value="${csrf}">
              <div class="field">
                <label for="update-schedule">Update automatically</label>
                <select id="update-schedule" name="schedule">${optionsHtml(UPDATE_SCHEDULE_LABELS, schedule)}</select>
              </div>
              <div class="field">
                <label for="update-hour">At</label>
                <select id="update-hour" name="hour">${optionsHtml(hours, String(hour))}</select>
                <p class="field-hint">In the ${escapeHtml(analytics.timeZone())} time zone, which you can change under Advanced mode. Shortify is offline for a few seconds while it restarts.</p>
              </div>
              <button class="button button-small button-quiet" type="submit">Save schedule</button>
            </form>`;
}

function twoFactorPanelHtml(csrf, user, errors) {
  if (!user.totp_secret) {
    return `<p class="status-line status-line-off">Off</p>
            <p class="card-intro">Ask for a code from an authenticator app as well as your password when you log in.</p>
            <form method="post" action="/settings/2fa/start#two-factor">
              <input type="hidden" name="csrf_token" value="${csrf}">
              <div class="field">
                <label for="two-factor-password">Your password</label>
                <input id="two-factor-password" name="password" type="password" autocomplete="current-password" ${fieldAria('two-factor-password-error', errors.twoFactorPassword)}>
                ${fieldError('two-factor-password-error', errors.twoFactorPassword)}
              </div>
              <button class="button button-small" type="submit">Set up two-factor login</button>
            </form>`;
  }
  const { count } = countRecoveryCodes.get(user.id);
  return `<p class="status-line status-line-good">On</p>
            <dl class="details">
              ${detailRow('Turned on', escapeHtml(formatLongDate(new Date(user.totp_enabled_at * 1000))))}
              ${detailRow('Recovery codes left', String(count))}
            </dl>
            <form class="backup-form" method="post">
              <input type="hidden" name="csrf_token" value="${csrf}">
              <div class="field">
                <label for="two-factor-password">Your password</label>
                <input id="two-factor-password" name="password" type="password" autocomplete="current-password" ${fieldAria('two-factor-password-error', errors.twoFactorPassword)}>
                ${fieldError('two-factor-password-error', errors.twoFactorPassword)}
              </div>
              <div class="field">
                <label for="two-factor-code">Code from your app, or a recovery code</label>
                <input id="two-factor-code" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="24" ${fieldAria('two-factor-code-error', errors.twoFactorCode)}>
                ${fieldError('two-factor-code-error', errors.twoFactorCode)}
              </div>
              <div class="confirm-actions">
                <button class="button button-small button-quiet" type="submit" formaction="/settings/2fa/recovery#two-factor">Get new recovery codes</button>
                <button class="button-text button-text-danger" type="submit" formaction="/settings/2fa/disable#two-factor">Turn off</button>
              </div>
            </form>`;
}

function twoFactorSetupHtml(csrf, user, secret, codeError) {
  return `<section class="card confirm-card two-factor-card" id="two-factor">
        <h2>Set up two-factor login</h2>
        <p>Scan this with an authenticator app, like Google Authenticator, Microsoft Authenticator or Aegis.</p>
        <div class="qr-image" role="img" aria-label="QR code for your authenticator app">${qr.toSvg(otpauthUrl(user.username, secret))}</div>
        <p class="two-factor-key">Can't scan it? Enter this key in your app:<br><code>${secret.match(/.{1,4}/g).join(' ')}</code></p>
        <form method="post" action="/settings/2fa/enable#two-factor">
          <input type="hidden" name="csrf_token" value="${csrf}">
          <div class="field">
            <label for="two-factor-code">6-digit code from your app</label>
            <input id="two-factor-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" autofocus ${fieldAria('two-factor-code-error', codeError)}>
            ${fieldError('two-factor-code-error', codeError)}
          </div>
          <div class="confirm-actions">
            <button class="button button-small" type="submit">Turn on two-factor login</button>
            <a class="button-text" href="/settings#two-factor">Cancel</a>
          </div>
        </form>
      </section>`;
}

function recoveryCodesHtml(codes, justEnabled) {
  return `<section class="card confirm-card two-factor-card" id="two-factor">
        <h2>Save your recovery codes</h2>
        <p role="status">${justEnabled ? 'Two-factor login is on, and other devices have been logged out. ' : 'Your old recovery codes no longer work. '}Each code below gets you in once if you lose your authenticator app. They won't be shown again, so keep them somewhere safe, like a password manager.</p>
        <ul class="recovery-codes">
          ${codes.map((code) => `<li><code>${code}</code></li>`).join('\n          ')}
        </ul>
        <div class="confirm-actions">
          <a class="button button-small" href="/settings#two-factor">I've saved them</a>
        </div>
      </section>`;
}

async function renderSettings(req, res, status, { notice, confirmDomain, confirmClearStats, hostname = '', connection = tunnel.isInstalled() ? 'tunnel' : 'direct', https = true, proxies, timeZone, newKey, twoFactorSecret, recoveryCodes, justEnabled = false, errors = {} } = {}) {
  const csrf = csrfToken(req, res);
  const user = sessionUser(req);
  const twoFactorView = (twoFactorSecret && twoFactorSetupHtml(csrf, user, twoFactorSecret, errors.twoFactorCode)) || (recoveryCodes && recoveryCodesHtml(recoveryCodes, justEnabled));
  const values = {
    two_factor_panel: twoFactorPanelHtml(csrf, user, errors),
    updates_panel: updatesPanelHtml(csrf),
    api_section: apiSectionHtml(req, csrf, newKey, errors.keyName),
    advanced_checked: analytics.isEnabled() ? 'checked' : '',
    retention_options: optionsHtml(RETENTION_LABELS, String(analytics.retentionDays())),
    time_zone: escapeHtml(timeZone ?? analytics.timeZone()),
    time_zone_aria: fieldAria('time-zone-error', errors.timeZone),
    time_zone_error: fieldError('time-zone-error', errors.timeZone),
    backup_aria: fieldAria('backup-error', errors.backup),
    backup_error: fieldError('backup-error', errors.backup),
    storage: await storageHtml(),
    sidebar: renderSidebar(req, csrf, 'settings'),
    csrf_token: csrf,
    username: escapeHtml(user.username),
    notice: Object.hasOwn(SETTINGS_NOTICES, notice ?? '') ? `<p class="notice" role="status">${SETTINGS_NOTICES[notice]}</p>` : '',
    confirm: twoFactorView || (confirmDomain && confirmRemoveDomainHtml(confirmDomain, csrf)) || (confirmClearStats && confirmClearStatsHtml(csrf)) || '',
    page_hidden: twoFactorView || confirmDomain || confirmClearStats ? 'hidden' : '',
    domain_list: domainListHtml(csrf),
    hostname: escapeHtml(hostname),
    connection_options: optionsHtml(CONNECTION_LABELS, connection),
    https_checked: https ? 'checked' : '',
    hostname_aria: fieldAria('hostname-error', errors.hostname),
    hostname_error: fieldError('hostname-error', errors.hostname),
    proxies: escapeHtml(proxies ?? listTrustedProxies().join('\n')),
    proxies_aria: fieldAria('proxies-error', errors.proxies),
    proxies_error: fieldError('proxies-error', errors.proxies),
    tunnel_panel: tunnelPanelHtml(csrf, await tunnel.status(), errors.token),
    https_panel: httpsPanelHtml(csrf, errors.certificate),
    current_aria: fieldAria('current-error', errors.current),
    current_error: fieldError('current-error', errors.current),
    password_aria: fieldAria('password-error', errors.password),
    password_error: fieldError('password-error', errors.password),
  };
  sendHtml(res, status, renderTemplate(SETTINGS_PAGE, values));
}

function parseHostname(input) {
  const trimmed = input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter a domain, like s.example.com.');
  let url;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    throw new Error('Enter just the domain, like s.example.com.');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Enter just the domain, without a path. Like s.example.com.');
  }
  return url.host;
}

function parseTunnelToken(input) {
  const candidates = input.match(/[A-Za-z0-9+/_-]{50,}={0,2}/g) || [];
  for (const candidate of candidates) {
    try {
      const decoded = JSON.parse(Buffer.from(candidate, 'base64').toString('utf8'));
      if (decoded.a && decoded.t && decoded.s) return candidate;
    } catch {
    }
  }
  throw new Error('That doesn\'t look like a tunnel token. Copy it again from Cloudflare.');
}

async function checkDomain(domain) {
  const url = `${domain.https ? 'https' : 'http'}://${domain.hostname}/.well-known/shortify-check`;
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(DOMAIN_CHECK_TIMEOUT_MS) });
    const body = response.ok ? (await response.text()).trim() : '';
    if (body === INSTANCE_ID) return null;
    return 'Something answers there, but it isn\'t this Shortify server.';
  } catch (error) {
    const cause = (error.cause && error.cause.code) || error.name;
    if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') return 'This server can\'t find that domain in DNS.';
    if (cause === 'TimeoutError' || cause === 'UND_ERR_CONNECT_TIMEOUT') return 'Nothing answered in time.';
    if (cause === 'ECONNREFUSED') return 'The connection was refused.';
    if (String(cause).includes('CERT') || String(cause).includes('TLS')) return 'Its HTTPS certificate isn\'t valid.';
    return 'This server couldn\'t reach it.';
  }
}

function sessionKey(req) {
  return hashToken(readCookie(req, SESSION_COOKIE));
}

async function refuseTwoFactorChange(req, user, form) {
  const address = clientAddress(req);
  if (!loginTries.reserve(address)) return { status: 429, errors: { twoFactorPassword: TOO_MANY_TRIES } };
  if (!await passwordMatches(form.get('password') || '', user.password_hash)) {
    return { status: 400, errors: { twoFactorPassword: 'That isn\'t your password.' } };
  }
  loginTries.clear(address);
  if (!twoFactorTries.reserve(user.id)) return { status: 429, errors: { twoFactorCode: TOO_MANY_TRIES } };
  if (!secondFactorMatches(user, form.get('code') || '')) return { status: 400, errors: { twoFactorCode: WRONG_CODE } };
  twoFactorTries.release(user.id);
  return null;
}

const settingsHandlers = {
  async '/settings/updates/run'(req, res) {
    if (!readStatus()) return redirect(res, '/settings#updates');
    requestAction('update');
    return redirect(res, '/settings?notice=update-started#updates');
  },

  async '/settings/updates/check'(req, res) {
    if (!readStatus()) return redirect(res, '/settings#updates');
    requestAction('check');
    return redirect(res, '/settings?notice=update-checking#updates');
  },

  async '/settings/updates/schedule'(req, res, form) {
    const schedule = form.get('schedule') || '';
    const hour = Number(form.get('hour'));
    if (!Object.hasOwn(UPDATE_SCHEDULE_LABELS, schedule) || !Number.isInteger(hour) || hour < 0 || hour > 23) return redirect(res, '/settings#updates');
    writeSetting.run('update_schedule', schedule);
    writeSetting.run('update_hour', String(hour));
    return redirect(res, '/settings?notice=update-schedule-saved#updates');
  },

  async '/settings/2fa/start'(req, res, form) {
    const user = sessionUser(req);
    if (user.totp_secret) return redirect(res, '/settings#two-factor');
    const address = clientAddress(req);
    if (!loginTries.reserve(address)) return renderSettings(req, res, 429, { errors: { twoFactorPassword: TOO_MANY_TRIES } });
    if (!await passwordMatches(form.get('password') || '', user.password_hash)) {
      return renderSettings(req, res, 400, { errors: { twoFactorPassword: 'That isn\'t your password.' } });
    }
    loginTries.clear(address);
    const secret = generateSecret();
    enrollments.set(sessionKey(req), { secret });
    return renderSettings(req, res, 200, { twoFactorSecret: secret });
  },

  async '/settings/2fa/enable'(req, res, form) {
    const user = sessionUser(req);
    const enrollment = enrollments.get(sessionKey(req));
    if (user.totp_secret) return redirect(res, '/settings#two-factor');
    if (!enrollment) return redirect(res, '/settings?notice=2fa-expired#two-factor');
    const { secret } = enrollment;
    if (!twoFactorTries.reserve(user.id)) {
      return renderSettings(req, res, 429, { twoFactorSecret: secret, errors: { twoFactorCode: TOO_MANY_TRIES } });
    }
    const step = matchingStep(secret, form.get('code') || '');
    if (step === null) {
      return renderSettings(req, res, 400, { twoFactorSecret: secret, errors: { twoFactorCode: 'That code isn\'t right. Check your app and try again.' } });
    }
    twoFactorTries.release(user.id);
    enrollments.delete(sessionKey(req));
    const codes = generateRecoveryCodes();
    enableTwoFactor(user.id, secret, nowSeconds(), step, codes.map(hashRecoveryCode));
    deleteOtherSessions.run(user.id, sessionKey(req));
    return renderSettings(req, res, 200, { recoveryCodes: codes, justEnabled: true });
  },

  async '/settings/2fa/recovery'(req, res, form) {
    const user = sessionUser(req);
    if (!user.totp_secret) return redirect(res, '/settings#two-factor');
    const refusal = await refuseTwoFactorChange(req, user, form);
    if (refusal) return renderSettings(req, res, refusal.status, { errors: refusal.errors });
    const codes = generateRecoveryCodes();
    replaceRecoveryCodes(user.id, codes.map(hashRecoveryCode));
    return renderSettings(req, res, 200, { recoveryCodes: codes });
  },

  async '/settings/2fa/disable'(req, res, form) {
    const user = sessionUser(req);
    if (!user.totp_secret) return redirect(res, '/settings#two-factor');
    const refusal = await refuseTwoFactorChange(req, user, form);
    if (refusal) return renderSettings(req, res, refusal.status, { errors: refusal.errors });
    disableTwoFactor(user.id);
    forgetPendingLogins(user.id);
    return redirect(res, '/settings?notice=2fa-off#two-factor');
  },

  async '/settings/domains'(req, res, form) {
    const connection = Object.hasOwn(CONNECTION_LABELS, form.get('connection')) ? form.get('connection') : 'direct';
    const https = form.get('https') === '1';
    const input = form.get('hostname') || '';
    const fields = { hostname: input, connection, https };
    let hostname;
    try {
      hostname = parseHostname(input);
    } catch (error) {
      return renderSettings(req, res, 400, { ...fields, errors: { hostname: error.message } });
    }
    if (findDomainByName.get(hostname)) {
      return renderSettings(req, res, 400, { ...fields, errors: { hostname: 'That domain is already here.' } });
    }
    insertDomain.run(hostname, connection, https ? 1 : 0);
    return redirect(res, '/settings?notice=domain-added');
  },

  async '/settings/domains/check'(req, res, form) {
    const domain = findDomain.get(Number(form.get('id')));
    if (!domain) return redirect(res, '/settings');
    recordDomainCheck.run(nowSeconds(), await checkDomain(domain), domain.id);
    return redirect(res, '/settings?notice=domain-checked');
  },

  async '/settings/domains/default'(req, res, form) {
    const domain = findDomain.get(Number(form.get('id')));
    if (form.get('clear') === '1') removeSetting.run('default_domain_id');
    else if (domain) writeSetting.run('default_domain_id', String(domain.id));
    return redirect(res, '/settings?notice=default-changed');
  },

  async '/settings/domains/remove'(req, res, form) {
    const domain = findDomain.get(Number(form.get('id')));
    if (!domain) return redirect(res, '/settings');
    if (form.get('confirm') !== '1') return renderSettings(req, res, 200, { confirmDomain: domain });
    deleteDomain.run(domain.id);
    if (Number(getSetting('default_domain_id')) === domain.id) removeSetting.run('default_domain_id');
    return redirect(res, '/settings?notice=domain-removed');
  },

  async '/settings/tunnel'(req, res, form) {
    if (!tunnel.isInstalled()) return redirect(res, '/settings');
    let token;
    try {
      token = parseTunnelToken(form.get('token') || '');
    } catch (error) {
      return renderSettings(req, res, 400, { errors: { token: error.message } });
    }
    writeSetting.run('tunnel_token', token);
    tunnel.start(token);
    return redirect(res, '/settings?notice=tunnel-saved');
  },

  async '/settings/tunnel/remove'(req, res) {
    removeSetting.run('tunnel_token');
    tunnel.stop();
    return redirect(res, '/settings?notice=tunnel-removed');
  },

  async '/settings/https'(req, res, form) {
    const certText = (form.get('cert') || '').trim();
    const keyText = (form.get('key') || '').trim();
    if (certText || keyText) {
      try {
        parseCertificate(certText, keyText);
      } catch (error) {
        return renderSettings(req, res, 400, { errors: { certificate: error.message } });
      }
      await fs.promises.writeFile(TLS_KEY_PATH, `${keyText}\n`, { mode: 0o600 });
      await fs.promises.writeFile(TLS_CERT_PATH, `${certText}\n`, { mode: 0o600 });
    }
    const certificate = readCertificate();
    if (certificate) startHttps(certificate);
    if (form.get('redirect') === '1' && certificate) writeSetting.run('https_redirect', '1');
    else removeSetting.run('https_redirect');
    return renderSettings(req, res, 200, { notice: 'https-saved' });
  },

  async '/settings/https/remove'(req, res) {
    stopHttps();
    await fs.promises.rm(TLS_CERT_PATH, { force: true });
    await fs.promises.rm(TLS_KEY_PATH, { force: true });
    removeSetting.run('https_redirect');
    return redirect(res, '/settings?notice=https-removed#https');
  },

  async '/settings/proxy'(req, res, form) {
    const input = form.get('proxies') || '';
    const addresses = [...new Set(input.split(/\s+/).filter(Boolean).map((address) => address.replace(/^::ffff:/, '')))];
    const invalid = addresses.find((address) => !net.isIP(address));
    if (invalid) {
      return renderSettings(req, res, 400, { proxies: input, errors: { proxies: `${invalid} isn't an IP address. Ranges aren't supported, so list each proxy.` } });
    }
    writeSetting.run('trusted_proxies', addresses.join(','));
    setTrustedProxies(addresses);
    return redirect(res, '/settings?notice=proxies-saved');
  },

  async '/settings/advanced'(req, res, form) {
    const timeZone = (form.get('time_zone') || 'UTC').trim();
    if (!timeZoneIsValid(timeZone)) {
      return renderSettings(req, res, 400, { timeZone, errors: { timeZone: 'That isn\'t a time zone this server knows. Try one like Europe/London or America/New_York.' } });
    }
    const retention = form.get('retention');
    writeSetting.run('advanced_mode', form.get('enabled') === '1' ? '1' : '0');
    writeSetting.run('analytics_time_zone', timeZone);
    if (Object.hasOwn(RETENTION_LABELS, retention)) writeSetting.run('analytics_retention_days', retention);
    analytics.prune();
    return redirect(res, '/settings?notice=advanced-saved#advanced');
  },

  async '/settings/api'(req, res, form) {
    const name = (form.get('name') || '').trim();
    if (!name) return renderSettings(req, res, 400, { errors: { keyName: 'Give the key a name, so you can tell what uses it.' } });
    if (!analytics.isEnabled()) return redirect(res, '/settings#advanced');
    const key = `sfy_${crypto.randomBytes(32).toString('base64url')}`;
    insertApiKey.run(name.slice(0, MAX_API_KEY_NAME_LENGTH), hashToken(key), nowSeconds());
    return renderSettings(req, res, 200, { newKey: key });
  },

  async '/settings/api/remove'(req, res, form) {
    deleteApiKey.run(Number(form.get('id')));
    return redirect(res, '/settings?notice=key-removed#advanced');
  },

  async '/settings/advanced/clear'(req, res, form) {
    if (form.get('confirm') !== '1') return renderSettings(req, res, 200, { confirmClearStats: true });
    analytics.clear();
    return redirect(res, '/settings?notice=stats-cleared#advanced');
  },

  async '/settings/backup'(req, res, form) {
    const user = sessionUser(req);
    const address = clientAddress(req);
    if (!loginTries.reserve(address)) return renderSettings(req, res, 429, { errors: { backup: 'Too many tries. Wait 15 minutes, then try again.' } });
    if (!await passwordMatches(form.get('password') || '', user.password_hash)) {
      return renderSettings(req, res, 400, { errors: { backup: 'That isn\'t your password.' } });
    }
    loginTries.clear(address);
    const backupPath = path.join(DATA_DIR, `backup-${crypto.randomBytes(8).toString('hex')}.db`);
    db.prepare('VACUUM INTO ?').run(backupPath);
    try {
      const { size } = await fs.promises.stat(backupPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename="shortify-backup-${dayString()}.db"`,
        'Cache-Control': 'no-store',
      });
      await pipeline(fs.createReadStream(backupPath), res);
    } catch (error) {
      if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
    } finally {
      await fs.promises.rm(backupPath, { force: true });
    }
    return undefined;
  },

  async '/settings/password'(req, res, form) {
    const user = sessionUser(req);
    const password = form.get('password') || '';
    const address = clientAddress(req);
    if (!loginTries.reserve(address)) return renderSettings(req, res, 429, { errors: { current: 'Too many tries. Wait 15 minutes, then try again.' } });
    if (!await passwordMatches(form.get('current') || '', user.password_hash)) {
      return renderSettings(req, res, 400, { errors: { current: 'That isn\'t your current password.' } });
    }
    loginTries.clear(address);
    if (password.length < MIN_PASSWORD_LENGTH) {
      return renderSettings(req, res, 400, { errors: { password: `Use at least ${MIN_PASSWORD_LENGTH} characters.` } });
    }
    updatePassword.run(await hashPassword(password), user.id);
    deleteOtherSessions.run(user.id, sessionKey(req));
    forgetPendingLogins(user.id);
    return redirect(res, '/settings?notice=password-changed');
  },
};

async function handleSettingsPost(req, res, handler, maxBytes) {
  if (!isLoggedIn(req)) return redirect(res, '/');
  const form = await readForm(req, maxBytes);
  if (!csrfValid(req, form)) return sendText(res, 403, PAGE_EXPIRED);
  return handler(req, res, form);
}

module.exports = {
  handleSettingsPost,
  renderSettings,
  settingsHandlers,
};
