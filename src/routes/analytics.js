'use strict';

const { csrfToken } = require('../auth');
const { busiestSlot, changeNote, clicksChartHtml, heatmapHtml, hourLabel, statHtml } = require('../charts');
const { COUNTRY_NAMES, DAY_SECONDS, KIND_LABELS, LANGUAGE_NAMES, RANGE_DAYS, RECENT_VISITS, WEEKDAYS } = require('../config');
const { csvRow, isoTime, startCsv } = require('../csv');
const { analytics, countLinks } = require('../db');
const { dayString, formatCount, formatDate, nowSeconds, optionsHtml, plural } = require('../format');
const { escapeHtml, sendHtml } = require('../http');
const { renderSidebar } = require('../layout');
const { ANALYTICS_PAGE, renderTemplate } = require('../views');

function zoneReader(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' });
  return (seconds) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(seconds * 1000)).map(({ type, value }) => [type, value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: WEEKDAYS.indexOf(parts.weekday) };
  };
}

function timeZoneIsValid(timeZone) {
  try {
    zoneReader(timeZone);
    return true;
  } catch {
    return false;
  }
}

function dayChartData(hours, reader, rangeDays) {
  const clicks = new Map();
  for (const { hour, count } of hours) {
    const { day } = reader(hour * 3600);
    clicks.set(day, (clicks.get(day) || 0) + count);
  }
  const today = Date.parse(`${reader(nowSeconds()).day}T00:00:00Z`);
  return Array.from({ length: rangeDays }, (_, index) => {
    const date = new Date(today - (rangeDays - 1 - index) * DAY_SECONDS * 1000);
    return { date, count: clicks.get(date.toISOString().slice(0, 10)) || 0 };
  });
}

function heatmapData(hours, reader) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const { hour, count } of hours) {
    const { weekday, hour: hourOfDay } = reader(hour * 3600);
    grid[weekday][hourOfDay] += count;
  }
  return grid;
}

function breakdownHtml(title, rows, emptyText, labelFor = (label) => label ?? 'Unknown') {
  const total = rows.reduce((sum, { count }) => sum + count, 0);
  if (total === 0) return `<section class="card breakdown"><h2>${title}</h2><p class="empty">${emptyText}</p></section>`;
  const items = rows.map((row) => {
    const share = (row.count / total) * 100;
    const barShare = (row.count / rows[0].count) * 100;
    const label = labelFor(row.label, row);
    const shown = row.href ? `<a href="${escapeHtml(row.href)}">${escapeHtml(label)}</a>` : `<span class="breakdown-label">${escapeHtml(label)}</span>`;
    return `<li>
              ${shown}
              <span class="top-count">${formatCount(row.count)}<span class="breakdown-share"> ${share < 1 ? '<1' : Math.round(share)}%</span></span>
              <svg class="top-bar" width="100%" height="6" aria-hidden="true">
                <rect class="top-bar-track" width="100%" height="6" rx="3"/>
                <rect class="top-bar-fill" width="${barShare.toFixed(1)}%" height="6" rx="3"/>
              </svg>
            </li>`;
  });
  return `<section class="card breakdown">
            <h2>${title}</h2>
            <ol class="top-links">
              ${items.join('\n              ')}
            </ol>
          </section>`;
}

function regionName(code) {
  if (!code) return 'Unknown';
  try {
    return COUNTRY_NAMES.of(code) || code;
  } catch {
    return code;
  }
}

function languageName(code) {
  if (!code) return 'Unknown';
  try {
    return LANGUAGE_NAMES.of(code) || code;
  } catch {
    return code;
  }
}

function linkBreakdownsHtml(since, until, linkId) {
  const cards = [
    breakdownHtml('Where visitors came from', analytics.breakdown('referrer', since, until, linkId), 'No clicks in this period.', (label) => label ?? 'Direct or unknown'),
    breakdownHtml('Countries', analytics.breakdown('country', since, until, linkId), 'No clicks in this period.', regionName),
    breakdownHtml('Devices', analytics.breakdown('device', since, until, linkId), 'No clicks in this period.'),
    breakdownHtml('Browsers', analytics.breakdown('browser', since, until, linkId), 'No clicks in this period.'),
    breakdownHtml('Operating systems', analytics.breakdown('os', since, until, linkId), 'No clicks in this period.'),
    breakdownHtml('Languages', analytics.breakdown('language', since, until, linkId), 'No clicks in this period.', languageName),
    breakdownHtml('Domains used', analytics.breakdown('host', since, until, linkId), 'No clicks in this period.'),
  ];
  return cards.join('\n          ');
}

function parseRange(params) {
  const retention = analytics.retentionDays();
  const options = RANGE_DAYS.filter((days) => days <= retention);
  if (!options.includes(retention)) options.push(retention);
  const requested = Number(params.get('range'));
  const rangeDays = options.includes(requested) ? requested : Math.min(30, retention);
  const until = nowSeconds() + 1;
  return { rangeDays, options, until, since: until - rangeDays * DAY_SECONDS };
}

function recentVisitsHtml(zone) {
  const visits = analytics.recentVisits(RECENT_VISITS);
  if (visits.length === 0) return '<p class="empty">Nothing yet. The latest visits will show here.</p>';
  const when = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const rows = visits.map((visit) => `<tr>
              <td>${escapeHtml(when.format(new Date(visit.ts * 1000)))}</td>
              <td><a href="/links/view?id=${visit.link_id}">/${escapeHtml(visit.slug)}</a></td>
              <td>${escapeHtml(visit.referrer ?? 'Direct')}</td>
              <td>${escapeHtml(regionName(visit.country))}</td>
              <td>${escapeHtml([visit.device, visit.browser].filter(Boolean).join(', '))}</td>
            </tr>`);
  return `<table class="visits">
            <thead>
              <tr><th scope="col">When</th><th scope="col">Link</th><th scope="col">From</th><th scope="col">Country</th><th scope="col">Device</th></tr>
            </thead>
            <tbody>
            ${rows.join('\n            ')}
            </tbody>
          </table>`;
}

function renderAnalytics(req, res, params) {
  const { rangeDays, options, since, until } = parseRange(params);
  const zone = analytics.timeZone();
  const reader = zoneReader(zone);
  const csrf = csrfToken(req, res);

  const summary = analytics.summary(since, until);
  const previous = analytics.summary(since - rangeDays * DAY_SECONDS, since);
  const hours = analytics.hours(since, until);
  const days = dayChartData(hours, reader, rangeDays);
  const grid = heatmapData(hours, reader);
  const busiestDay = days.reduce((top, day) => (day.count > top.count ? day : top));
  const slot = busiestSlot(grid);
  const unit = `${rangeDays} days`;
  const security = analytics.security(new Date((since) * 1000).toISOString().slice(0, 10));
  const [topReferrer] = analytics.breakdown('referrer', since, until, null, 1);

  const stats = [
    statHtml('Clicks', formatCount(summary.clicks), changeNote(summary.clicks, previous.clicks, unit)),
    statHtml('Visitors', formatCount(summary.visitors), changeNote(summary.visitors, previous.visitors, unit)),
    statHtml('Bot visits', formatCount(summary.bots), 'Not counted as clicks here'),
    statHtml('Links clicked', formatCount(summary.links), `Of ${plural(countLinks.get().count, 'link')}`),
    statHtml('Per day', (summary.clicks / rangeDays).toFixed(1), summary.visitors ? `${(summary.clicks / summary.visitors).toFixed(1)} clicks per visitor` : 'No visitors yet'),
    statHtml('Busiest day', busiestDay.count ? formatDate(busiestDay.date) : 'None', busiestDay.count ? plural(busiestDay.count, 'click') : 'No clicks yet'),
    statHtml('Busiest time', slot.count ? `${WEEKDAYS[slot.weekday]} ${slot.hour}h` : 'None', slot.count ? `${hourLabel(slot.hour)}, ${plural(slot.count, 'click')}` : 'No clicks yet'),
    statHtml('Top source', topReferrer ? escapeHtml(topReferrer.label ?? 'Direct') : 'None', topReferrer ? plural(topReferrer.count, 'click') : 'No clicks yet'),
  ];

  const topRows = analytics.topLinks(since, until).map((link) => ({ label: `/${link.slug}`, count: link.count, href: `/links/view?id=${link.id}` }));
  const securityRows = [
    { label: 'Wrong PINs', count: security.pin_failed || 0 },
    { label: 'Failed logins', count: security.login_failed || 0 },
    { label: 'Visits to expired links', count: security.expired_visit || 0 },
  ].filter(({ count }) => count > 0).sort((a, b) => b.count - a.count);
  const breakdowns = [
    breakdownHtml('Top links', topRows, 'No clicks in this period.'),
    breakdownHtml('Link types', analytics.kinds(since, until), 'No clicks in this period.', (label) => KIND_LABELS[label] ?? label),
    linkBreakdownsHtml(since, until),
    breakdownHtml('Blocked and failed', securityRows, 'No wrong PINs, failed logins or visits to expired links.'),
  ];

  const hasVisits = summary.clicks > 0;
  const shownBreakdowns = hasVisits ? breakdowns : [securityRows.length ? breakdowns[breakdowns.length - 1] : ''];

  const rangeLabels = Object.fromEntries(options.map((days) => [days, `Last ${days} days`]));
  const values = {
    sidebar: renderSidebar(req, csrf, 'analytics'),
    range: rangeDays,
    range_options: optionsHtml(rangeLabels, String(rangeDays)),
    range_label: `Last ${rangeDays} days`,
    time_zone: escapeHtml(zone),
    stats: stats.join('\n            '),
    day_chart: clicksChartHtml(days),
    heatmap: heatmapHtml(grid),
    recent_visits: recentVisitsHtml(zone),
    breakdowns: shownBreakdowns.join('\n          '),
    retention_days: analytics.retentionDays(),
  };
  sendHtml(res, 200, renderTemplate(ANALYTICS_PAGE, values));
}

function sendAnalyticsCsv(res, params) {
  const { since, until } = parseRange(params);
  startCsv(res, `shortify-clicks-${dayString()}.csv`);
  res.write(csvRow(['time', 'ending', 'bot', 'domain', 'referrer', 'country', 'language', 'device', 'browser', 'os']));
  for (const row of analytics.exportRows(since, until)) {
    res.write(csvRow([isoTime(row.ts), row.slug, row.bot ? 'yes' : 'no', row.host, row.referrer, row.country, row.language, row.device, row.browser, row.os]));
  }
  res.end();
}

module.exports = {
  heatmapData,
  linkBreakdownsHtml,
  renderAnalytics,
  sendAnalyticsCsv,
  timeZoneIsValid,
  zoneReader,
};
