'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { isBot } = require('../analytics');
const { clientAddress, clientCountry, passwordMatches, pinTriesByLink, missedLinksByVisitor, pinTriesByVisitor } = require('../auth');
const { SLUG_PATTERN } = require('../config');
const { FILES_DIR, analytics, consumeUse, findLink, findLinkText, recordClick } = require('../db');
const { dayString, formatBytes, formatCount } = require('../format');
const { escapeHtml, fieldAria, fieldError, readForm, redirect, renderMessage, sendHtml, sendText } = require('../http');
const { linkHasExpired, shortUrl } = require('../links');
const { PIN_PAGE, TEXT_PAGE, renderTemplate } = require('../views');

function sendTextLink(res, link) {
  const { content } = findLinkText.get(link.id);
  sendHtml(res, 200, TEXT_PAGE.replace('{{ text }}', () => escapeHtml(content)));
}

async function sendFileLink(req, res, link) {
  const filePath = path.join(FILES_DIR, link.file_id);
  const { size } = await fs.promises.stat(filePath);
  const asciiName = link.file_name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encodedName = encodeURIComponent(link.file_name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  try {
    return await pipeline(fs.createReadStream(filePath), res);
  } catch (error) {
    if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') return undefined;
    throw error;
  }
}

function renderNotFound(res) {
  renderMessage(res, 404, 'This link doesn\'t exist', '<p>Check it for typos, or ask the person who shared it. It may also have been deleted.</p>');
}

function renderGone(res) {
  analytics.noteSecurity('expired_visit');
  renderMessage(res, 410, 'This link has expired', '<p>It reached its time or click limit, so it no longer opens. Ask the person who shared it for a new one.</p>');
}

function serveLink(req, res, link) {
  const userAgent = req.headers['user-agent'] || '';
  const bot = isBot(userAgent);
  const limited = link.click_limit !== null;

  if (limited && (bot || req.method === 'HEAD')) {
    return renderMessage(res, 403, 'Open this in a browser', '<p>This link can only be opened a limited number of times, so it isn\'t shown to automated visitors.</p>');
  }

  if (req.method !== 'HEAD') {
    if (!bot && consumeUse.run(link.id).changes === 0) return renderGone(res);
    recordClick.run(link.id, dayString());
    analytics.recordClick(link.id, {
      address: clientAddress(req),
      userAgent,
      referer: req.headers.referer,
      acceptLanguage: req.headers['accept-language'],
      host: req.headers.host,
      country: clientCountry(req),
    });
  }
  if (link.kind === 'text') return sendTextLink(res, link);
  if (link.kind === 'file') return sendFileLink(req, res, link);
  return redirect(res, link.url, req.method === 'POST' ? 303 : 302);
}

function renderPreview(req, res, link) {
  const address = escapeHtml(shortUrl(req, link));
  if (linkHasExpired(link)) {
    return renderMessage(res, 410, 'This link has expired', '<p>It reached its time or click limit, so it no longer opens.</p>');
  }
  if (link.pin_hash) {
    return renderMessage(res, 200, 'This link is protected', `<p>It needs a PIN, so where it goes stays hidden until then.</p><p class="message-actions"><a class="button button-small" href="${address}">Enter the PIN</a></p>`);
  }
  if (link.click_limit !== null) {
    return renderMessage(res, 200, 'This link has limited opens', `<p>It can only be opened a set number of times, so where it goes stays hidden until then. Opening it uses 1 of its ${formatCount(link.click_limit - link.uses)} remaining ${link.click_limit - link.uses === 1 ? 'open' : 'opens'}.</p><p class="message-actions"><a class="button button-small" href="${address}" rel="noreferrer">Open it</a></p>`);
  }
  let what;
  if (link.kind === 'url') what = `<p>This short link goes to:</p><p class="preview-target">${escapeHtml(link.url)}</p>`;
  else if (link.kind === 'text') what = '<p>This short link opens some shared text.</p>';
  else what = `<p>This short link downloads a file:</p><p class="preview-target">${escapeHtml(link.file_name)} (${formatBytes(link.file_size)})</p>`;
  return renderMessage(res, 200, 'Before you open this', `${what}<p class="message-actions"><a class="button button-small" href="${address}" rel="noreferrer">Continue</a></p>`);
}

function renderPinPage(res, status, message) {
  const values = { pin_aria: fieldAria('pin-error', message), pin_error: fieldError('pin-error', message) };
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  sendHtml(res, status, renderTemplate(PIN_PAGE, values));
}

function findLinkAtPath(pathname) {
  const slug = pathname.slice(1);
  return SLUG_PATTERN.test(slug) ? findLink.get(slug) : null;
}

async function followLink(req, res, pathname) {
  const address = clientAddress(req);
  if (missedLinksByVisitor.isLocked(address)) return renderMessage(res, 429, 'Too many missing links', '<p>This address has asked for too many links that don\'t exist. Wait 15 minutes, then try again.</p>');
  if (pathname.endsWith('+')) {
    const previewed = findLinkAtPath(pathname.slice(0, -1));
    if (previewed) return renderPreview(req, res, previewed);
    missedLinksByVisitor.reserve(address);
    return renderNotFound(res);
  }
  const link = findLinkAtPath(pathname);
  if (!link) {
    missedLinksByVisitor.reserve(address);
    return renderNotFound(res);
  }
  if (linkHasExpired(link)) return renderGone(res);
  if (link.pin_hash) return renderPinPage(res, 200);
  return serveLink(req, res, link);
}

async function handleLinkPin(req, res, pathname) {
  const link = findLinkAtPath(pathname);
  if (!link || !link.pin_hash) return sendText(res, 404, 'Not found.');
  if (linkHasExpired(link)) return renderGone(res);
  const form = await readForm(req);

  const visitor = `${clientAddress(req)}|${link.id}`;
  const tooMany = 'Too many tries. Wait 15 minutes, then try again.';
  if (!pinTriesByVisitor.reserve(visitor)) return renderPinPage(res, 429, tooMany);
  if (!pinTriesByLink.reserve(link.id)) {
    pinTriesByVisitor.release(visitor);
    return renderPinPage(res, 429, tooMany);
  }

  if (!await passwordMatches(form.get('pin') || '', link.pin_hash)) {
    analytics.noteSecurity('pin_failed');
    const locked = pinTriesByVisitor.isLocked(visitor) || pinTriesByLink.isLocked(link.id);
    return renderPinPage(res, locked ? 429 : 401, locked ? tooMany : 'That PIN isn\'t right. Try again.');
  }

  pinTriesByVisitor.clear(visitor);
  pinTriesByLink.release(link.id);
  return serveLink(req, res, link);
}

module.exports = {
  followLink,
  handleLinkPin,
};
