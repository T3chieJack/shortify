'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const tls = require('node:tls');
const { peerIsTrusted } = require('./auth');
const { HTTPS_PORT, HTTPS_PUBLIC_PORT } = require('./config');
const { TLS_CERT_PATH, TLS_KEY_PATH, getSetting } = require('./db');
const { redirect, sendText } = require('./http');
const { ASSETS } = require('./views');
const { DAY_SECONDS } = require('./config');

function readCertificate() {
  try {
    return { cert: fs.readFileSync(TLS_CERT_PATH), key: fs.readFileSync(TLS_KEY_PATH) };
  } catch {
    return null;
  }
}

function parseCertificate(certText, keyText) {
  let certificate;
  try {
    certificate = new crypto.X509Certificate(certText);
  } catch {
    throw new Error('That certificate can\'t be read. Paste it in PEM format, starting with -----BEGIN CERTIFICATE-----.');
  }
  let key;
  try {
    key = crypto.createPrivateKey(keyText);
  } catch {
    throw new Error('That private key can\'t be read. Paste it in PEM format, without a passphrase.');
  }
  if (!certificate.checkPrivateKey(key)) throw new Error('That private key doesn\'t belong to this certificate.');
  if (Date.parse(certificate.validTo) <= Date.now()) throw new Error('That certificate has already expired.');
  tls.createSecureContext({ cert: certText, key: keyText });
  return certificate;
}

function shouldRedirectToHttps(req, pathname) {
  if (!httpsServer || req.socket.encrypted || pathname === '/healthz' || ASSETS.has(pathname)) return false;
  return getSetting('https_redirect') === '1' && !peerIsTrusted(req);
}

function strictTransportHeader(req) {
  if (req.socket.encrypted && getSetting('https_redirect') === '1') return `max-age=${DAY_SECONDS}`;
  return null;
}

function redirectToHttps(req, res) {
  const host = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d+)?$/i.exec(req.headers.host || '');
  if (!host) return sendText(res, 400, 'Bad Host header.');
  const port = HTTPS_PUBLIC_PORT === 443 ? '' : `:${HTTPS_PUBLIC_PORT}`;
  return redirect(res, `https://${host[1]}${port}${req.url}`, 308);
}

let httpsServer = null;

let requestHandler = null;

function setHttpsHandler(handler) {
  requestHandler = handler;
}

function startHttps({ cert, key }) {
  if (httpsServer) {
    httpsServer.setSecureContext({ cert, key });
    return;
  }
  httpsServer = https.createServer({ cert, key }, requestHandler);
  httpsServer.listen(HTTPS_PORT, () => console.log(`Shortify listening for HTTPS on port ${HTTPS_PORT}`));
}

function stopHttps() {
  if (!httpsServer) return;
  httpsServer.close();
  httpsServer.closeAllConnections();
  httpsServer = null;
}

module.exports = {
  strictTransportHeader,
  parseCertificate,
  readCertificate,
  redirectToHttps,
  setHttpsHandler,
  shouldRedirectToHttps,
  startHttps,
  stopHttps,
};
