'use strict';

const http = require('node:http');
const tunnel = require('./tunnel');
const { isLoggedIn, requestIsHttps } = require('./auth');
const { MAX_CERTIFICATE_BODY_BYTES, PORT } = require('./config');
const { INSTANCE_ID, analytics, findLink, findLinkById, getSetting } = require('./db');
const { SECURITY_HEADERS, redirect, sendText } = require('./http');
const { readCertificate, redirectToHttps, setHttpsHandler, shouldRedirectToHttps, strictTransportHeader, startHttps } = require('./https-server');
const { renderAnalytics, sendAnalyticsCsv } = require('./routes/analytics');
const { routeApi } = require('./routes/api');
const { handleCreateLink, renderDashboard } = require('./routes/dashboard');
const { renderLinkPage, sendQrCode } = require('./routes/link');
const { handleBulkAdd, handleDeleteLinks, handleEditLinks, renderLinks, sendLinksCsv } = require('./routes/links');
const { handleLogin, handleLogout, prepareLogin, renderLogin } = require('./routes/login');
const { handleSettingsPost, renderSettings, settingsHandlers } = require('./routes/settings');
const { followLink, handleLinkPin } = require('./routes/visit');
const { isSetupPending, prepareFirstRun, routeFirstRun } = require('./setup');
const { ASSETS } = require('./views');

async function route(req, res) {
  const [pathname, query] = req.url.split('?');
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (shouldRedirectToHttps(req, pathname)) return redirectToHttps(req, res);
  if (isSetupPending() && !ASSETS.has(pathname) && pathname !== '/healthz') return routeFirstRun(req, res, pathname);

  if (pathname === '/api/links' || pathname.startsWith('/api/links/')) return routeApi(req, res, pathname, query);

  if (method === 'GET') {
    if (pathname === '/healthz') return sendText(res, 200, 'ok');
    if (pathname === '/setup') return redirect(res, '/');
    if (pathname === '/') {
      if (isLoggedIn(req)) return redirect(res, '/dashboard');
      return renderLogin(req, res, 200);
    }
    if (pathname === '/dashboard') {
      if (!isLoggedIn(req)) return redirect(res, '/');
      const created = findLink.get(new URLSearchParams(query).get('created') || '');
      return renderDashboard(req, res, 200, { created });
    }
    if (pathname === '/settings') {
      if (!isLoggedIn(req)) return redirect(res, '/');
      return renderSettings(req, res, 200, { notice: new URLSearchParams(query).get('notice') });
    }
    if (pathname === '/.well-known/shortify-check') return sendText(res, 200, INSTANCE_ID);
    if (pathname === '/robots.txt') return sendText(res, 200, 'User-agent: *\nDisallow: /');
    if (pathname === '/analytics' || pathname === '/analytics/export') {
      if (!isLoggedIn(req)) return redirect(res, '/');
      if (!analytics.isEnabled()) return redirect(res, '/settings#advanced');
      const params = new URLSearchParams(query);
      return pathname === '/analytics' ? renderAnalytics(req, res, params) : sendAnalyticsCsv(res, params);
    }
    if (pathname === '/links/export') {
      if (!isLoggedIn(req)) return redirect(res, '/');
      return sendLinksCsv(req, res, new URLSearchParams(query));
    }
    if (pathname === '/links/view' || pathname === '/links/qr') {
      if (!isLoggedIn(req)) return redirect(res, '/');
      const params = new URLSearchParams(query);
      const link = findLinkById.get(Number(params.get('id')));
      if (!link) return sendText(res, 404, 'Not found.');
      return pathname === '/links/view' ? renderLinkPage(req, res, link) : sendQrCode(req, res, link, params.get('download') === '1');
    }
    if (pathname === '/links') {
      if (!isLoggedIn(req)) return redirect(res, '/');
      return renderLinks(req, res, 200, { params: new URLSearchParams(query) });
    }
    const asset = ASSETS.get(pathname);
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' });
      return res.end(asset.body);
    }
    return followLink(req, res, pathname);
  }

  if (method === 'POST') {
    if (pathname === '/login') return handleLogin(req, res);
    if (pathname === '/logout') return handleLogout(req, res);
    if (pathname === '/links') return handleCreateLink(req, res);
    if (pathname === '/links/bulk') return handleBulkAdd(req, res);
    if (pathname === '/links/delete') return handleDeleteLinks(req, res);
    if (pathname === '/links/edit') return handleEditLinks(req, res);
    if (pathname === '/settings/https') return handleSettingsPost(req, res, settingsHandlers[pathname], MAX_CERTIFICATE_BODY_BYTES);
    if (Object.hasOwn(settingsHandlers, pathname)) return handleSettingsPost(req, res, settingsHandlers[pathname]);
    return handleLinkPin(req, res, pathname);
  }

  return sendText(res, 404, 'Not found.');
}

function handleRequest(req, res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const strictTransport = strictTransportHeader(req);
  if (strictTransport) res.setHeader('Strict-Transport-Security', strictTransport);
  if (requestIsHttps(req)) res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  route(req, res).catch((error) => {
    if (error.tooLarge) {
      res.destroy();
      return;
    }
    console.error(error);
    if (!res.headersSent) sendText(res, 500, 'Something went wrong.');
    else res.end();
  });
}

process.on('exit', () => tunnel.kill());

process.on('SIGTERM', () => process.exit(0));

process.on('SIGINT', () => process.exit(0));

(async () => {
  setHttpsHandler(handleRequest);
  await prepareLogin();
  await prepareFirstRun();
  analytics.startPruning();
  http.createServer(handleRequest).listen(PORT, () => console.log(`Shortify listening on port ${PORT}`));
  const certificate = readCertificate();
  if (certificate) startHttps(certificate);
  const tunnelToken = getSetting('tunnel_token');
  if (tunnelToken && tunnel.isInstalled()) tunnel.start(tunnelToken);
})();
