'use strict';

const { hashPassword, hashToken } = require('../auth');
const { API_PAGE_SIZE, EXPIRY_PRESETS, MAX_API_BODY_BYTES, MAX_TEXT_BYTES, PIN_ERROR, PIN_PATTERN, SLUG_PATTERN } = require('../config');
const { isoTime } = require('../csv');
const { analytics, countFilteredLinks, defaultDomainId, findApiKey, findDomainByName, findLink, findLinkById, insertLink, insertTag, listLinks, touchApiKey } = require('../db');
const { nowSeconds } = require('../format');
const { readForm, sendJson } = require('../http');
const { checkSlug, generateSlug, linkHasExpired, parseClickLimit, parseExpiry, parseLinkUrl, parseTags, removeLinks, shortUrl } = require('../links');
const { linksFilter, parseLinksQuery } = require('./links');

function apiKeyIsValid(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  const key = match && findApiKey.get(hashToken(match[1]));
  if (key) touchApiKey.run(nowSeconds(), key.id);
  return Boolean(key);
}

function readApiBody(req) {
  return readForm(req, MAX_API_BODY_BYTES, (buffer) => {
    try {
      const body = JSON.parse(buffer.toString('utf8'));
      return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  });
}

function apiLink(req, link) {
  return {
    id: link.id,
    slug: link.slug,
    short_url: shortUrl(req, link),
    type: link.kind,
    url: link.kind === 'url' ? link.url : null,
    file_name: link.kind === 'file' ? link.file_name : null,
    clicks: link.clicks,
    has_pin: Boolean(link.has_pin),
    expired: linkHasExpired(link),
    expires_at: link.expires_at === null ? null : isoTime(link.expires_at),
    click_limit: link.click_limit,
    opens_used: link.uses,
    tags: link.tags ? link.tags.split(',').sort() : [],
    created_at: isoTime(link.created_at),
  };
}

async function apiCreateLink(req, res) {
  const body = await readApiBody(req);
  if (!body) return sendJson(res, 400, { error: 'Send a JSON object.' });

  const fieldIs = (name, type) => body[name] === undefined || body[name] === null || typeof body[name] === type;
  for (const name of ['url', 'text', 'slug', 'pin', 'expires', 'domain']) {
    if (!fieldIs(name, 'string')) return sendJson(res, 400, { error: `${name} must be text.` });
  }
  if (!fieldIs('click_limit', 'number')) return sendJson(res, 400, { error: 'click_limit must be a number.' });
  if (body.tags !== undefined && body.tags !== null && !(Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === 'string'))) {
    return sendJson(res, 400, { error: 'tags must be a list of text.' });
  }
  if (Boolean(body.url) === Boolean(body.text)) return sendJson(res, 400, { error: 'Send either url or text.' });

  try {
    const link = { url: '', kind: body.url ? 'url' : 'text', content: null, fileId: null, fileName: null, fileSize: null, domainId: defaultDomainId(), pinHash: null, expiresAt: null, clickLimit: null };
    if (body.url) link.url = parseLinkUrl(body.url.trim());
    if (body.text) {
      if (Buffer.byteLength(body.text) > MAX_TEXT_BYTES) throw new Error('That text is too long. The limit is 1 MB.');
      link.content = body.text;
    }
    if (body.slug) checkSlug(body.slug);
    if (body.pin && !PIN_PATTERN.test(body.pin)) throw new Error(PIN_ERROR);
    if (body.expires) {
      link.expiresAt = parseExpiry(Object.hasOwn(EXPIRY_PRESETS, body.expires) ? body.expires : 'date', body.expires);
    }
    if (body.click_limit !== undefined && body.click_limit !== null) link.clickLimit = parseClickLimit(String(body.click_limit));
    const tags = parseTags((body.tags || []).join(','));
    if (body.domain) {
      const domain = findDomainByName.get(body.domain);
      if (!domain) throw new Error(`${body.domain} isn't one of your domains.`);
      link.domainId = domain.id;
    }
    if (body.pin) link.pinHash = await hashPassword(body.pin);

    const slug = body.slug || generateSlug();
    if (findLink.get(slug)) throw new Error('That ending is already in use. Try another.');
    const { lastInsertRowid } = insertLink.run({ ...link, slug, createdAt: nowSeconds() });
    for (const tag of tags) insertTag.run(lastInsertRowid, tag);
    return sendJson(res, 201, apiLink(req, findLinkById.get(lastInsertRowid)));
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
}

async function routeApi(req, res, pathname, query) {
  if (!analytics.isEnabled()) return sendJson(res, 403, { error: 'The API is off. Turn on advanced mode in Settings.' });
  if (!apiKeyIsValid(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return sendJson(res, 401, { error: 'Send a valid API key as: Authorization: Bearer <key>' });
  }

  if (pathname === '/api/links') {
    if (req.method === 'POST') return apiCreateLink(req, res);
    if (req.method === 'GET') {
      const params = new URLSearchParams(query);
      const filter = linksFilter(parseLinksQuery(params));
      const offset = Math.max(Number(params.get('offset')) || 0, 0);
      const links = listLinks.newest.all({ ...filter, limit: API_PAGE_SIZE, offset }).map((link) => apiLink(req, link));
      return sendJson(res, 200, { total: countFilteredLinks.get(filter).count, offset, links });
    }
    return sendJson(res, 405, { error: 'Use GET or POST here.' });
  }

  const match = /^\/api\/links\/([^/]+)$/.exec(pathname);
  const found = match && SLUG_PATTERN.test(match[1]) ? findLink.get(match[1]) : null;
  if (!found) return sendJson(res, 404, { error: 'Not found.' });
  const link = findLinkById.get(found.id);
  if (req.method === 'GET') return sendJson(res, 200, apiLink(req, link));
  if (req.method === 'DELETE') {
    await removeLinks([link]);
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  return sendJson(res, 405, { error: 'Use GET or DELETE here.' });
}

module.exports = {
  routeApi,
};
