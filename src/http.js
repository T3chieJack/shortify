'use strict';

const { MAX_BODY_BYTES } = require('./config');
const { MESSAGE_PAGE, renderTemplate } = require('./views');

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${text}\n`);
}

function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function fieldError(id, message) {
  return message ? `<p class="field-error" id="${id}">${escapeHtml(message)}</p>` : '';
}

function fieldAria(id, message) {
  return message ? `aria-invalid="true" aria-describedby="${id}"` : '';
}

function readForm(req, maxBytes = MAX_BODY_BYTES, parse = (buffer) => new URLSearchParams(buffer.toString('utf8'))) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Body too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(parse(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${JSON.stringify(body)}\n`);
}

function renderMessage(res, status, title, body) {
  const values = { title: escapeHtml(title), body };
  sendHtml(res, status, renderTemplate(MESSAGE_PAGE, values));
}

module.exports = {
  SECURITY_HEADERS,
  escapeHtml,
  fieldAria,
  fieldError,
  readForm,
  redirect,
  renderMessage,
  sendHtml,
  sendJson,
  sendText,
};
