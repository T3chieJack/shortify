'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { requestIsHttps } = require('./auth');
const { CURRENT_ADDRESS, EXPIRY_PRESETS, MAX_CLICK_LIMIT, MAX_FILE_NAME_LENGTH, MAX_TAGS, MAX_URL_LENGTH, RESERVED_SLUGS, SLUG_ALPHABET, SLUG_LENGTH, SLUG_PATTERN, TAG_PATTERN } = require('./config');
const { FILES_DIR, db, defaultDomainId, deleteLink, findDomain, findLink, listDomains } = require('./db');
const { formatBytes, formatCount, nowSeconds } = require('./format');
const { escapeHtml } = require('./http');

function parseLinkUrl(input) {
  if (!input) throw new Error('Enter a link to shorten.');
  if (input.length > MAX_URL_LENGTH) throw new Error(`Links can be up to ${MAX_URL_LENGTH} characters long.`);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('Enter a web address, like https://wiki.homelab.lan/notes.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Links must start with http:// or https://.');
  if (url.username || url.password) throw new Error('Enter a web address without a username or password in it.');
  return url.href;
}

function checkSlug(slug) {
  if (!SLUG_PATTERN.test(slug)) throw new Error('Use up to 64 letters, numbers, hyphens and underscores, starting with a letter or number.');
  if (RESERVED_SLUGS.has(slug.toLowerCase())) throw new Error('Shortify uses that ending itself. Try another.');
  if (findLink.get(slug)) throw new Error('That ending is already in use. Try another.');
}

function cleanFileName(name) {
  const base = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base.slice(-MAX_FILE_NAME_LENGTH) || 'file';
}

function parseTags(input) {
  const tags = [...new Set(input.toLowerCase().split(/[\s,]+/).map((tag) => tag.replace(/^#/, '')).filter(Boolean))];
  const invalid = tags.find((tag) => !TAG_PATTERN.test(tag));
  if (invalid) throw new Error(`"${invalid}" won't work as a tag. Use letters, numbers, hyphens and underscores.`);
  if (tags.length > MAX_TAGS) throw new Error(`Use up to ${MAX_TAGS} tags.`);
  return tags;
}

function parseClickLimit(input) {
  if (!/^\d+$/.test(input) || Number(input) < 1 || Number(input) > MAX_CLICK_LIMIT) {
    throw new Error('Enter a whole number, like 1 for a one-time link.');
  }
  return Number(input);
}

function parseExpiry(choice, date) {
  if (!choice) return null;
  if (Object.hasOwn(EXPIRY_PRESETS, choice)) return nowSeconds() + EXPIRY_PRESETS[choice];
  if (choice !== 'date') throw new Error('Choose when this link should expire.');
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T23:59:59Z`) : NaN;
  if (Number.isNaN(parsed)) throw new Error('Choose a date.');
  if (parsed <= Date.now()) throw new Error('Choose a date in the future.');
  return Math.floor(parsed / 1000);
}

function linkHasExpired({ expires_at: expiresAt, click_limit: clickLimit, uses }) {
  if (expiresAt !== null && expiresAt <= nowSeconds()) return true;
  return clickLimit !== null && uses >= clickLimit;
}

function generateSlug() {
  for (;;) {
    let slug = '';
    for (let i = 0; i < SLUG_LENGTH; i += 1) slug += SLUG_ALPHABET[crypto.randomInt(SLUG_ALPHABET.length)];
    if (!RESERVED_SLUGS.has(slug) && !findLink.get(slug)) return slug;
  }
}

function linkBadges(link) {
  const badges = [];
  if (linkHasExpired(link)) badges.push('<span class="badge badge-expired">Expired</span>');
  if (link.has_pin) badges.push('<span class="badge badge-pin">PIN</span>');
  if (link.click_limit !== null && !linkHasExpired(link)) {
    const left = link.click_limit - link.uses;
    badges.push(`<span class="badge badge-limit">${formatCount(left)} ${left === 1 ? 'open' : 'opens'} left</span>`);
  }
  if (link.tags) {
    for (const tag of link.tags.split(',').sort()) badges.push(`<a class="tag" href="/links?tag=${encodeURIComponent(tag)}">#${escapeHtml(tag)}</a>`);
  }
  return badges.length ? `${badges.join(' ')} ` : '';
}

function linkTarget({ kind, url, snippet, file_name: fileName, file_size: fileSize }) {
  if (kind === 'text') return snippet.replace(/\s+/g, ' ').trim();
  if (kind === 'file') return `${fileName} (${formatBytes(fileSize)})`;
  return url;
}

function linkTargetCell(link) {
  const badges = linkBadges(link);
  const title = escapeHtml(linkTarget(link));
  if (link.kind === 'text') return `<td title="${title}">${badges}<span class="badge">Text</span> ${title}</td>`;
  if (link.kind === 'file') return `<td title="${title}">${badges}<span class="badge">File</span> ${title}</td>`;
  return `<td title="${title}">${badges}${title.replace(/^https?:\/\//, '')}</td>`;
}

function shortUrl(req, { slug, domain_id: domainId }) {
  const domain = domainId ? findDomain.get(domainId) : null;
  if (domain) return `${domain.https ? 'https' : 'http'}://${domain.hostname}/${slug}`;
  return `${requestIsHttps(req) ? 'https' : 'http'}://${req.headers.host}/${slug}`;
}

function shortLabel({ slug, domain_id: domainId }) {
  const domain = domainId ? findDomain.get(domainId) : null;
  return domain ? `${domain.hostname}/${slug}` : `/${slug}`;
}

function shortLinkHtml(req, link) {
  return `<a href="${escapeHtml(shortUrl(req, link))}">${escapeHtml(shortLabel(link))}</a>`;
}

function domainOptionsHtml(req, selected) {
  const options = [[CURRENT_ADDRESS, 'Current address'], ...listDomains.all().map((domain) => [domain.id, domain.hostname])];
  return options.map(([value, label]) => `<option value="${value}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

function parseDomainChoice(value) {
  if (value === CURRENT_ADDRESS) return null;
  const id = Number(value);
  return id && findDomain.get(id) ? id : defaultDomainId();
}

async function removeLinks(links) {
  db.exec('BEGIN');
  for (const link of links) deleteLink.run(link.id);
  db.exec('COMMIT');
  await Promise.all(links.filter((link) => link.file_id).map((link) => fs.promises.rm(path.join(FILES_DIR, link.file_id), { force: true })));
}

module.exports = {
  checkSlug,
  cleanFileName,
  domainOptionsHtml,
  generateSlug,
  linkHasExpired,
  linkTarget,
  linkTargetCell,
  parseClickLimit,
  parseDomainChoice,
  parseExpiry,
  parseLinkUrl,
  parseTags,
  removeLinks,
  shortLabel,
  shortLinkHtml,
  shortUrl,
};
