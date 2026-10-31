'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { csrfToken, csrfValid, hashPassword, isLoggedIn } = require('../auth');
const { clicksChartHtml, weekChangeNote } = require('../charts');
const { CHART_DAYS, CURRENT_ADDRESS, DAY_SECONDS, EXPIRY_LABELS, LINK_KINDS, MAX_CREATE_REQUEST_BYTES, MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB, PAGE_EXPIRED, PIN_ERROR, PIN_PATTERN, RECENT_LINKS, TOP_LINKS } = require('../config');
const { FILES_DIR, clicksByDay, countClicks, countLinks, countLinksSince, defaultDomainId, findLink, insertLink, insertTag, listDomains, recentLinks, topLinks } = require('../db');
const { dayString, formatCount, formatDate, nowSeconds } = require('../format');
const { escapeHtml, fieldAria, fieldError, redirect, sendHtml, sendText } = require('../http');
const { renderSidebar } = require('../layout');
const { checkSlug, cleanFileName, domainOptionsHtml, generateSlug, linkTargetCell, parseClickLimit, parseDomainChoice, parseExpiry, parseLinkUrl, parseTags, shortLinkHtml, shortUrl } = require('../links');
const { expiryFieldHtml } = require('./links');
const { DASHBOARD_PAGE, renderTemplate } = require('../views');

function createdHtml(url, linkId) {
  return `<div class="field created" role="status">
      <label for="short-url">Your short link</label>
      <div class="copy-wrap">
        <input id="short-url" type="text" readonly value="${escapeHtml(url)}">
        <button class="toggle" id="copy" type="button" hidden>Copy</button>
      </div>
      <p class="field-hint"><a href="/links/view?id=${linkId}">QR code and details</a></p>
    </div>`;
}

function recentLinksHtml(req) {
  const links = recentLinks.all(RECENT_LINKS);
  if (links.length === 0) return '<p class="empty">No short links yet. Create your first one with the form on this page.</p>';
  const rows = links.map((link) => {
    const { clicks, created_at: createdAt } = link;
    return `<tr>
          <td>${shortLinkHtml(req, link)}</td>
          ${linkTargetCell(link)}
          <td>${formatCount(clicks)}</td>
          <td>${formatDate(new Date(createdAt * 1000))}</td>
        </tr>`;
  });
  return `<table class="links">
      <thead>
        <tr><th scope="col">Short link</th><th scope="col">Goes to</th><th scope="col">Clicks</th><th scope="col">Created</th></tr>
      </thead>
      <tbody>
        ${rows.join('\n        ')}
      </tbody>
    </table>`;
}

function topLinksHtml() {
  const links = topLinks.all(TOP_LINKS);
  if (links.length === 0) return '<p class="empty">Your most-used links will show here once they get clicks.</p>';
  const rows = links.map(({ slug, clicks }) => {
    const share = (clicks / links[0].clicks) * 100;
    return `<li>
          <a href="/${escapeHtml(slug)}">/${escapeHtml(slug)}</a>
          <span class="top-count">${formatCount(clicks)}</span>
          <svg class="top-bar" width="100%" height="6" aria-hidden="true">
            <rect class="top-bar-track" width="100%" height="6" rx="3"/>
            <rect class="top-bar-fill" width="${share.toFixed(1)}%" height="6" rx="3"/>
          </svg>
        </li>`;
  });
  return `<ol class="top-links">
        ${rows.join('\n        ')}
      </ol>`;
}

function renderDashboard(req, res, status, { kind = 'url', url = '', text = '', slug = '', pin = '', domain, expiry = '', expiryDate = '', limit = '', tags = '', urlError, textError, fileError, slugError, pinError, expiryError, limitError, tagsError, created } = {}) {
  const host = escapeHtml(req.headers.host || '');
  const clicks = new Map(clicksByDay.all(dayString(CHART_DAYS - 1)).map(({ day, count }) => [day, count]));
  const clicksOn = (daysAgo) => clicks.get(dayString(daysAgo)) || 0;
  const sumDays = (from, to) => {
    let sum = 0;
    for (let daysAgo = from; daysAgo <= to; daysAgo += 1) sum += clicksOn(daysAgo);
    return sum;
  };
  const chartDays = Array.from({ length: CHART_DAYS }, (_, index) => {
    const daysAgo = CHART_DAYS - 1 - index;
    return { date: new Date(`${dayString(daysAgo)}T00:00:00Z`), count: clicksOn(daysAgo) };
  });
  const week = sumDays(0, 6);
  const newLinks = countLinksSince.get(nowSeconds() - 7 * DAY_SECONDS).count;
  const [topLink] = topLinks.all(1);
  const csrf = csrfToken(req, res);
  const values = {
    sidebar: renderSidebar(req, csrf, 'dashboard'),
    csrf_token: csrf,
    host,
    kind_url: kind === 'url' ? 'checked' : '',
    kind_text: kind === 'text' ? 'checked' : '',
    kind_file: kind === 'file' ? 'checked' : '',
    url: escapeHtml(url),
    text: escapeHtml(text),
    slug: escapeHtml(slug),
    max_upload_mb: MAX_UPLOAD_MB,
    max_upload_bytes: MAX_UPLOAD_BYTES,
    url_aria: fieldAria('url-error', urlError),
    url_error: fieldError('url-error', urlError),
    text_aria: fieldAria('text-error', textError),
    text_error: fieldError('text-error', textError),
    file_aria: fieldAria('file-error', fileError),
    file_error: fieldError('file-error', fileError),
    pin: escapeHtml(pin),
    pin_aria: fieldAria('pin-error', pinError),
    pin_error: fieldError('pin-error', pinError),
    slug_prefix: listDomains.all().length
      ? `<select class="slug-domain" name="domain" aria-label="Domain">${domainOptionsHtml(req, domain ?? (defaultDomainId() || CURRENT_ADDRESS))}</select><span class="slug-slash">/</span>`
      : `<span class="slug-host">${host}/</span>`,
    slug_aria: fieldAria('slug-error', slugError),
    slug_error: fieldError('slug-error', slugError),
    created: created ? createdHtml(shortUrl(req, created), created.id) : '',
    more_open: pin || expiry || limit || tags ? 'open' : '',
    expiry_field: expiryFieldHtml('create', EXPIRY_LABELS, expiry, expiryDate, expiryError),
    limit: escapeHtml(limit),
    limit_aria: fieldAria('limit-error', limitError),
    limit_error: fieldError('limit-error', limitError),
    tags: escapeHtml(tags),
    tags_aria: fieldAria('tags-error', tagsError),
    tags_error: fieldError('tags-error', tagsError),
    stat_today: formatCount(clicksOn(0)),
    stat_today_note: `${formatCount(clicksOn(1))} yesterday`,
    stat_week: formatCount(week),
    stat_week_note: weekChangeNote(week, sumDays(7, 13)),
    stat_clicks: formatCount(countClicks.get().count),
    stat_clicks_note: topLink ? `Most on /${escapeHtml(topLink.slug)}` : 'None yet',
    stat_links: formatCount(countLinks.get().count),
    stat_links_note: `${formatCount(newLinks)} new this week`,
    clicks_chart: clicksChartHtml(chartDays),
    chart_days: CHART_DAYS,
    top_links: topLinksHtml(),
    recent_links: recentLinksHtml(req),
  };
  sendHtml(res, status, renderTemplate(DASHBOARD_PAGE, values));
}

function readCreateForm(req) {
  const headers = { 'Content-Type': req.headers['content-type'] || '' };
  return new Response(Readable.toWeb(req), { headers }).formData();
}

function formText(form, name) {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

async function handleCreateLink(req, res) {
  if (!isLoggedIn(req)) return redirect(res, '/');

  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length)) return sendText(res, 411, 'Content-Length is required.');
  if (length > MAX_CREATE_REQUEST_BYTES) {
    req.resume();
    return renderDashboard(req, res, 413, { kind: 'file', fileError: `That file is too big. The limit is ${MAX_UPLOAD_MB} MB.` });
  }

  let form;
  try {
    form = await readCreateForm(req);
  } catch {
    return renderDashboard(req, res, 400, { kind: 'file', fileError: 'That upload did not finish. Try again.' });
  }
  if (!csrfValid(req, form)) {
    return sendText(res, 403, PAGE_EXPIRED);
  }

  const requestedKind = formText(form, 'kind');
  const kind = LINK_KINDS.includes(requestedKind) ? requestedKind : 'url';
  const input = formText(form, 'url').trim();
  const text = formText(form, 'text');
  const requestedSlug = formText(form, 'slug').trim();
  const pin = formText(form, 'pin').trim();
  const domain = formText(form, 'domain');
  const expiry = formText(form, 'expiry');
  const expiryDate = formText(form, 'expiry_date');
  const limit = formText(form, 'limit').trim();
  const tagsInput = formText(form, 'tags').trim();
  const fields = { kind, url: input, text, slug: requestedSlug, pin, domain: domain || undefined, expiry, expiryDate, limit, tags: tagsInput };

  const link = { url: '', kind, content: null, fileId: null, fileName: null, fileSize: null, domainId: parseDomainChoice(domain), pinHash: null, expiresAt: null, clickLimit: null };
  const file = form.get('file');

  if (kind === 'url') {
    try {
      link.url = parseLinkUrl(input);
    } catch (error) {
      return renderDashboard(req, res, 400, { ...fields, urlError: error.message });
    }
  } else if (kind === 'text') {
    if (!text.trim()) return renderDashboard(req, res, 400, { ...fields, textError: 'Enter some text to share.' });
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
      return renderDashboard(req, res, 400, { ...fields, textError: 'That text is too long. The limit is 1 MB. Try sharing it as a file.' });
    }
    link.content = text;
  } else {
    if (!(file instanceof File) || !file.name) return renderDashboard(req, res, 400, { ...fields, fileError: 'Choose a file to share.' });
    if (file.size === 0) return renderDashboard(req, res, 400, { ...fields, fileError: 'That file is empty. Choose another.' });
    if (file.size > MAX_UPLOAD_BYTES) {
      return renderDashboard(req, res, 413, { ...fields, fileError: `That file is too big. The limit is ${MAX_UPLOAD_MB} MB.` });
    }
  }

  if (requestedSlug) {
    try {
      checkSlug(requestedSlug);
    } catch (error) {
      return renderDashboard(req, res, 400, { ...fields, slugError: error.message });
    }
  }

  if (pin) {
    if (!PIN_PATTERN.test(pin)) return renderDashboard(req, res, 400, { ...fields, pinError: PIN_ERROR });
  }

  try {
    link.expiresAt = parseExpiry(expiry, expiryDate);
  } catch (error) {
    return renderDashboard(req, res, 400, { ...fields, expiryError: error.message });
  }
  if (limit) {
    try {
      link.clickLimit = parseClickLimit(limit);
    } catch (error) {
      return renderDashboard(req, res, 400, { ...fields, limitError: error.message });
    }
  }
  let tags;
  try {
    tags = parseTags(tagsInput);
  } catch (error) {
    return renderDashboard(req, res, 400, { ...fields, tagsError: error.message });
  }

  if (pin) link.pinHash = await hashPassword(pin);

  if (kind === 'file') {
    link.fileId = crypto.randomBytes(16).toString('hex');
    link.fileName = cleanFileName(file.name);
    link.fileSize = file.size;
    const filePath = path.join(FILES_DIR, link.fileId);
    try {
      await pipeline(Readable.fromWeb(file.stream()), fs.createWriteStream(filePath));
    } catch (error) {
      await fs.promises.rm(filePath, { force: true });
      throw error;
    }
  }

  const slug = requestedSlug || generateSlug();
  if (findLink.get(slug)) {
    if (link.fileId) await fs.promises.unlink(path.join(FILES_DIR, link.fileId));
    return renderDashboard(req, res, 400, { ...fields, slugError: 'That ending is already in use. Try another.' });
  }
  const { lastInsertRowid } = insertLink.run({ ...link, slug, createdAt: nowSeconds() });
  for (const tag of tags) insertTag.run(lastInsertRowid, tag);
  return redirect(res, `/dashboard?created=${slug}`);
}

module.exports = {
  handleCreateLink,
  renderDashboard,
};
