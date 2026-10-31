'use strict';

const qr = require('../qr');
const { csrfToken } = require('../auth');
const { clicksChartHtml, heatmapHtml, statHtml, weekChangeNote } = require('../charts');
const { CHART_DAYS, DAY_SECONDS } = require('../config');
const { analytics, linkClicksByDay } = require('../db');
const { dayString, detailRow, formatCount, nowSeconds, plural } = require('../format');
const { escapeHtml, sendHtml } = require('../http');
const { renderSidebar } = require('../layout');
const { linkHasExpired, linkTarget, shortLabel, shortUrl } = require('../links');
const { heatmapData, linkBreakdownsHtml, zoneReader } = require('./analytics');
const { LINK_PAGE, renderTemplate } = require('../views');

function expiryText(link) {
  if (link.expires_at === null) return 'Never';
  const when = new Date(link.expires_at * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: analytics.timeZone() });
  return `${link.expires_at <= nowSeconds() ? 'Expired' : 'Expires'} ${escapeHtml(when)}`;
}

function linkDetailHtml(link) {
  if (!analytics.isEnabled()) {
    return `<section class="card">
            <h2>More detail</h2>
            <p class="card-intro">Turn on advanced mode in <a href="/settings#advanced">Settings</a> to see where this link's visitors come from, their devices, and more.</p>
          </section>`;
  }
  const until = nowSeconds() + 1;
  const since = until - analytics.retentionDays() * DAY_SECONDS;
  const summary = analytics.summary(since, until, link.id);
  if (summary.clicks === 0) {
    return `<section class="card">
            <h2>More detail</h2>
            <p class="empty">Where visitors come from, their devices and more will show here after this link's next visit.</p>
          </section>`;
  }
  const grid = heatmapData(analytics.hours(since, until, link.id), zoneReader(analytics.timeZone()));
  return `<section class="card">
            <div class="card-head">
              <h2>Busiest times</h2>
              <p class="card-meta">${formatCount(summary.visitors)} visitors, ${plural(summary.bots, 'bot visit')}, last ${analytics.retentionDays()} days</p>
            </div>
            ${heatmapHtml(grid)}
          </section>
          <div class="breakdowns breakdowns-narrow">
          ${linkBreakdownsHtml(since, until, link.id)}
          </div>`;
}

function renderLinkPage(req, res, link) {
  const csrf = csrfToken(req, res);
  const url = shortUrl(req, link);
  const clicks = new Map(linkClicksByDay.all(link.id, dayString(CHART_DAYS - 1)).map(({ day, count }) => [day, count]));
  const clicksOn = (daysAgo) => clicks.get(dayString(daysAgo)) || 0;
  const days = Array.from({ length: CHART_DAYS }, (_, index) => {
    const daysAgo = CHART_DAYS - 1 - index;
    return { date: new Date(`${dayString(daysAgo)}T00:00:00Z`), count: clicksOn(daysAgo) };
  });
  const sum = (from, to) => {
    let total = 0;
    for (let daysAgo = from; daysAgo <= to; daysAgo += 1) total += clicksOn(daysAgo);
    return total;
  };

  const targetValue = link.kind === 'url'
    ? `<a href="${escapeHtml(link.url)}" rel="noreferrer">${escapeHtml(link.url)}</a>`
    : escapeHtml(linkTarget(link));
  const limitText = link.click_limit === null
    ? 'None'
    : `${formatCount(link.uses)} of ${formatCount(link.click_limit)} used`;
  const tags = link.tags ? link.tags.split(',').sort().map((tag) => `<a class="tag" href="/links?tag=${encodeURIComponent(tag)}">#${escapeHtml(tag)}</a>`).join(' ') : 'None';
  const details = [
    detailRow('Status', linkHasExpired(link) ? '<span class="badge-expired">Expired</span>' : 'Active'),
    detailRow(link.kind === 'url' ? 'Goes to' : 'Shares', targetValue),
    detailRow('Type', { url: 'Link', text: 'Text', file: 'File' }[link.kind]),
    detailRow('Created', escapeHtml(new Date(link.created_at * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: analytics.timeZone() }))),
    detailRow('PIN', link.has_pin ? 'On' : 'Off'),
    detailRow('Expires', expiryText(link)),
    detailRow('Click limit', limitText),
    detailRow('Tags', tags),
    detailRow('Preview', `<a href="${escapeHtml(url)}+">Add + to any short link</a> to see where it goes before opening it.`),
  ];

  const stats = [
    statHtml('All clicks', formatCount(link.clicks), link.click_limit === null ? 'Since it was created' : limitText),
    statHtml('Last 7 days', formatCount(sum(0, 6)), weekChangeNote(sum(0, 6), sum(7, 13))),
    statHtml('Today', formatCount(clicksOn(0)), `${formatCount(clicksOn(1))} yesterday`),
    statHtml('Last 30 days', formatCount(sum(0, 29)), `${(sum(0, 29) / 30).toFixed(1)} per day`),
  ];
  const values = {
    sidebar: renderSidebar(req, csrf, 'links'),
    csrf_token: csrf,
    id: link.id,
    label: escapeHtml(shortLabel(link)),
    short_url: escapeHtml(url),
    details: details.join('\n              '),
    stats: stats.join('\n              '),
    chart_days: CHART_DAYS,
    clicks_chart: clicksChartHtml(days),
    advanced: linkDetailHtml(link),
  };
  sendHtml(res, 200, renderTemplate(LINK_PAGE, values));
}

function sendQrCode(req, res, link, download) {
  const headers = { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' };
  if (download) headers['Content-Disposition'] = `attachment; filename="shortify-${link.slug}.svg"`;
  res.writeHead(200, headers);
  res.end(qr.toSvg(shortUrl(req, link)));
}

module.exports = {
  renderLinkPage,
  sendQrCode,
};
