'use strict';

const crypto = require('node:crypto');

const DAY_SECONDS = 24 * 60 * 60;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_LABEL_LENGTH = 253;

const BOT_PATTERN = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|slack|discord|skype|embedly|curl|wget|python|go-http|node-fetch|axios|java\/|libwww|headless|monitor|uptime|scanner|preview/i;

function isBot(userAgent) {
  return !userAgent || BOT_PATTERN.test(userAgent);
}

function parseDevice(userAgent) {
  if (/ipad|tablet|kindle|silk|playbook/i.test(userAgent)) return 'Tablet';
  if (/mobi|iphone|ipod/i.test(userAgent)) return 'Phone';
  if (/android/i.test(userAgent)) return 'Tablet';
  return 'Desktop';
}

function parseBrowser(userAgent) {
  if (/edg(e|a|ios)?\//i.test(userAgent)) return 'Edge';
  if (/opr\/|opera/i.test(userAgent)) return 'Opera';
  if (/samsungbrowser/i.test(userAgent)) return 'Samsung Internet';
  if (/firefox|fxios/i.test(userAgent)) return 'Firefox';
  if (/chrome|crios|chromium/i.test(userAgent)) return 'Chrome';
  if (/safari/i.test(userAgent)) return 'Safari';
  return 'Other';
}

function parseOs(userAgent) {
  if (/windows/i.test(userAgent)) return 'Windows';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'iOS';
  if (/android/i.test(userAgent)) return 'Android';
  if (/mac os x|macintosh/i.test(userAgent)) return 'macOS';
  if (/cros/i.test(userAgent)) return 'ChromeOS';
  if (/linux/i.test(userAgent)) return 'Linux';
  return 'Other';
}

function parseReferrer(referer) {
  if (!referer) return null;
  try {
    const { hostname, protocol } = new URL(referer);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return hostname.replace(/^www\./, '').slice(0, MAX_LABEL_LENGTH) || null;
  } catch {
    return null;
  }
}

function parseLanguage(acceptLanguage) {
  const match = /^\s*([a-z]{2,3})\b/i.exec(acceptLanguage || '');
  return match ? match[1].toLowerCase() : null;
}

function parseCountry(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
}

function createAnalytics(db, { getSetting, writeSetting }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS click_events (
      id INTEGER PRIMARY KEY,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      visitor TEXT NOT NULL,
      bot INTEGER NOT NULL,
      host TEXT,
      referrer TEXT,
      country TEXT,
      language TEXT,
      device TEXT,
      browser TEXT,
      os TEXT
    );
    CREATE INDEX IF NOT EXISTS click_events_ts ON click_events (ts);
    CREATE INDEX IF NOT EXISTS click_events_link_ts ON click_events (link_id, ts);
    CREATE TABLE IF NOT EXISTS security_counts (
      day TEXT NOT NULL,
      name TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (day, name)
    );
  `);

  const insertEvent = db.prepare(`
    INSERT INTO click_events (link_id, ts, visitor, bot, host, referrer, country, language, device, browser, os)
    VALUES (:linkId, :ts, :visitor, :bot, :host, :referrer, :country, :language, :device, :browser, :os)
  `);
  const bumpSecurity = db.prepare(`
    INSERT INTO security_counts (day, name, count) VALUES (?, ?, 1)
    ON CONFLICT (day, name) DO UPDATE SET count = count + 1
  `);
  const pruneEvents = db.prepare('DELETE FROM click_events WHERE ts < ?');
  const pruneSecurity = db.prepare('DELETE FROM security_counts WHERE day < ?');
  const clearEvents = db.prepare('DELETE FROM click_events');
  const clearSecurity = db.prepare('DELETE FROM security_counts');
  const eventStats = db.prepare('SELECT COUNT(*) AS count, MIN(ts) AS oldest FROM click_events');

  const FILTER = 'ts >= :since AND ts < :until AND (:link IS NULL OR link_id = :link)';
  const summaryQuery = db.prepare(`
    SELECT
      COALESCE(SUM(bot = 0), 0) AS clicks,
      COALESCE(SUM(bot = 1), 0) AS bots,
      COUNT(DISTINCT CASE WHEN bot = 0 THEN visitor END) AS visitors,
      COUNT(DISTINCT CASE WHEN bot = 0 THEN link_id END) AS links
    FROM click_events WHERE ${FILTER}
  `);
  const hoursQuery = db.prepare(`SELECT ts / 3600 AS hour, COUNT(*) AS count FROM click_events WHERE bot = 0 AND ${FILTER} GROUP BY hour`);
  const breakdownQueries = Object.fromEntries(['referrer', 'country', 'language', 'device', 'browser', 'os', 'host'].map((column) => [column, db.prepare(`
    SELECT ${column} AS label, COUNT(*) AS count FROM click_events
    WHERE bot = 0 AND ${FILTER} GROUP BY ${column} ORDER BY count DESC, label LIMIT :limit
  `)]));
  const topLinksQuery = db.prepare(`
    SELECT links.id, links.slug, links.kind, COUNT(*) AS count
    FROM click_events JOIN links ON links.id = click_events.link_id
    WHERE click_events.bot = 0 AND ts >= :since AND ts < :until
    GROUP BY links.id ORDER BY count DESC, links.id DESC LIMIT :limit
  `);
  const kindsQuery = db.prepare(`
    SELECT links.kind AS label, COUNT(*) AS count
    FROM click_events JOIN links ON links.id = click_events.link_id
    WHERE click_events.bot = 0 AND ts >= :since AND ts < :until
    GROUP BY links.kind ORDER BY count DESC
  `);
  const recentVisitsQuery = db.prepare(`
    SELECT click_events.ts, links.id AS link_id, links.slug, click_events.referrer, click_events.country,
      click_events.device, click_events.browser
    FROM click_events JOIN links ON links.id = click_events.link_id
    WHERE click_events.bot = 0 ORDER BY click_events.ts DESC, click_events.id DESC LIMIT ?
  `);
  const securityQuery = db.prepare('SELECT name, SUM(count) AS count FROM security_counts WHERE day >= ? GROUP BY name');
  const exportQuery = db.prepare(`
    SELECT click_events.ts, links.slug, click_events.bot, click_events.host, click_events.referrer,
      click_events.country, click_events.language, click_events.device, click_events.browser, click_events.os
    FROM click_events JOIN links ON links.id = click_events.link_id
    WHERE ts >= :since AND ts < :until ORDER BY ts
  `);

  function isEnabled() {
    return getSetting('advanced_mode') === '1';
  }

  function retentionDays() {
    return Number(getSetting('analytics_retention_days')) || 90;
  }

  function timeZone() {
    return getSetting('analytics_time_zone') || 'UTC';
  }

  function dailySalt() {
    const day = new Date().toISOString().slice(0, 10);
    const stored = getSetting('analytics_salt');
    if (stored && stored.startsWith(`${day}:`)) return stored;
    const salt = `${day}:${crypto.randomBytes(32).toString('hex')}`;
    writeSetting.run('analytics_salt', salt);
    return salt;
  }

  function recordClick(linkId, { address, userAgent, referer, acceptLanguage, host, country }) {
    if (!isEnabled()) return;
    try {
      const bot = isBot(userAgent);
      const visitor = crypto.createHash('sha256').update(`${dailySalt()}|${address}|${userAgent}`).digest('hex').slice(0, 32);
      insertEvent.run({
        linkId,
        ts: Math.floor(Date.now() / 1000),
        visitor,
        bot: bot ? 1 : 0,
        host: host ? String(host).slice(0, MAX_LABEL_LENGTH) : null,
        referrer: parseReferrer(referer),
        country: parseCountry(country),
        language: parseLanguage(acceptLanguage),
        device: bot ? null : parseDevice(userAgent || ''),
        browser: bot ? null : parseBrowser(userAgent || ''),
        os: bot ? null : parseOs(userAgent || ''),
      });
    } catch (error) {
      console.error('Could not record a click:', error.message);
    }
  }

  function noteSecurity(name) {
    if (!isEnabled()) return;
    try {
      bumpSecurity.run(new Date().toISOString().slice(0, 10), name);
    } catch (error) {
      console.error('Could not record an event:', error.message);
    }
  }

  function prune() {
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays() * DAY_SECONDS;
    pruneEvents.run(cutoff);
    pruneSecurity.run(new Date(cutoff * 1000).toISOString().slice(0, 10));
  }

  function clear() {
    clearEvents.run();
    clearSecurity.run();
  }

  function startPruning() {
    prune();
    setInterval(prune, PRUNE_INTERVAL_MS).unref();
  }

  const window = (since, until, link) => ({ since, until, link: link ?? null });

  return {
    isEnabled,
    retentionDays,
    timeZone,
    recordClick,
    noteSecurity,
    prune,
    clear,
    startPruning,
    storedEvents: () => eventStats.get(),
    summary: (since, until, link) => summaryQuery.get(window(since, until, link)),
    hours: (since, until, link) => hoursQuery.all(window(since, until, link)),
    breakdown: (column, since, until, link, limit = 8) => breakdownQueries[column].all({ ...window(since, until, link), limit }),
    topLinks: (since, until, limit = 8) => topLinksQuery.all({ since, until, limit }),
    kinds: (since, until) => kindsQuery.all({ since, until }),
    recentVisits: (limit) => recentVisitsQuery.all(limit),
    security: (sinceDay) => Object.fromEntries(securityQuery.all(sinceDay).map(({ name, count }) => [name, count])),
    exportRows: (since, until) => exportQuery.iterate({ since, until }),
  };
}

module.exports = { createAnalytics, isBot };
