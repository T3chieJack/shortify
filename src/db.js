'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAnalytics } = require('./analytics');
const { DATA_DIR } = require('./config');

const FILES_DIR = path.join(DATA_DIR, 'files');

const TLS_DIR = path.join(DATA_DIR, 'tls');

const TLS_CERT_PATH = path.join(TLS_DIR, 'cert.pem');

const TLS_KEY_PATH = path.join(TLS_DIR, 'key.pem');

fs.mkdirSync(FILES_DIR, { recursive: true });

fs.mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });

const db = new DatabaseSync(path.join(DATA_DIR, 'shortify.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS link_clicks (
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (link_id, day)
  );
`);

if (!db.prepare('PRAGMA table_info(links)').all().some((column) => column.name === 'kind')) {
  db.exec(`
    BEGIN;
    ALTER TABLE links ADD COLUMN kind TEXT NOT NULL DEFAULT 'url';
    ALTER TABLE links ADD COLUMN content TEXT;
    ALTER TABLE links ADD COLUMN file_id TEXT;
    ALTER TABLE links ADD COLUMN file_name TEXT;
    ALTER TABLE links ADD COLUMN file_size INTEGER;
    COMMIT;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY,
    hostname TEXT NOT NULL UNIQUE COLLATE NOCASE,
    connection TEXT NOT NULL,
    https INTEGER NOT NULL,
    checked_at INTEGER,
    check_error TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

if (!db.prepare('PRAGMA table_info(links)').all().some((column) => column.name === 'domain_id')) {
  db.exec(`
    BEGIN;
    ALTER TABLE links ADD COLUMN domain_id INTEGER REFERENCES domains(id) ON DELETE SET NULL;
    ALTER TABLE links ADD COLUMN pin_hash TEXT;
    COMMIT;
  `);
}

if (!db.prepare('PRAGMA table_info(links)').all().some((column) => column.name === 'expires_at')) {
  db.exec(`
    BEGIN;
    ALTER TABLE links ADD COLUMN expires_at INTEGER;
    ALTER TABLE links ADD COLUMN click_limit INTEGER;
    ALTER TABLE links ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;
    COMMIT;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS link_tags (
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (link_id, tag)
  );
  CREATE INDEX IF NOT EXISTS link_tags_tag ON link_tags (tag);
`);

const countUsers = db.prepare('SELECT COUNT(*) AS count FROM users');

const insertUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');

const findUser = db.prepare('SELECT id, password_hash FROM users WHERE username = ?');

const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');

const findSessionUser = db.prepare(`
  SELECT users.id, users.username, users.password_hash FROM sessions JOIN users ON users.id = sessions.user_id
  WHERE sessions.token_hash = ? AND sessions.expires_at > ?
`);

const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');

const deleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

const insertLink = db.prepare(`
  INSERT INTO links (slug, url, created_at, kind, content, file_id, file_name, file_size, domain_id, pin_hash, expires_at, click_limit)
  VALUES (:slug, :url, :createdAt, :kind, :content, :fileId, :fileName, :fileSize, :domainId, :pinHash, :expiresAt, :clickLimit)
`);

const LINK_COLUMNS = `links.id, links.slug, links.url, links.created_at, links.kind, SUBSTR(links.content, 1, 200) AS snippet,
    links.file_id, links.file_name, links.file_size, links.domain_id, links.pin_hash IS NOT NULL AS has_pin,
    links.expires_at, links.click_limit, links.uses,
    (SELECT GROUP_CONCAT(tag, ',') FROM link_tags WHERE link_tags.link_id = links.id) AS tags`;

const findLink = db.prepare('SELECT id, slug, url, kind, file_id, file_name, file_size, domain_id, pin_hash, expires_at, click_limit, uses FROM links WHERE slug = ?');

const findLinkText = db.prepare('SELECT content FROM links WHERE id = ?');

const findLinkById = db.prepare(`
  SELECT ${LINK_COLUMNS}, COALESCE((SELECT SUM(count) FROM link_clicks WHERE link_id = links.id), 0) AS clicks
  FROM links WHERE links.id = ?
`);

const consumeUse = db.prepare('UPDATE links SET uses = uses + 1 WHERE id = ? AND (click_limit IS NULL OR uses < click_limit)');

const updateLinkTarget = db.prepare('UPDATE links SET url = ? WHERE id = ?');

const updateLinkSlug = db.prepare('UPDATE links SET slug = ? WHERE id = ?');

const updateLinkExpiry = db.prepare('UPDATE links SET expires_at = ? WHERE id = ?');

const updateLinkLimit = db.prepare('UPDATE links SET click_limit = ?, uses = 0 WHERE id = ?');

const insertTag = db.prepare('INSERT OR IGNORE INTO link_tags (link_id, tag) VALUES (?, ?)');

const deleteTag = db.prepare('DELETE FROM link_tags WHERE link_id = ? AND tag = ?');

const listTags = db.prepare('SELECT tag, COUNT(*) AS count FROM link_tags GROUP BY tag ORDER BY tag');

const linkClicksByDay = db.prepare('SELECT day, count FROM link_clicks WHERE link_id = ? AND day >= ?');

const storageTotals = db.prepare('SELECT COUNT(file_id) AS files, COALESCE(SUM(file_size), 0) AS bytes FROM links');

const deleteLink = db.prepare('DELETE FROM links WHERE id = ?');

const updateLinkDomain = db.prepare('UPDATE links SET domain_id = ? WHERE id = ?');

const updateLinkPin = db.prepare('UPDATE links SET pin_hash = ? WHERE id = ?');

const listDomains = db.prepare(`
  SELECT domains.*, COUNT(links.id) AS link_count
  FROM domains LEFT JOIN links ON links.domain_id = domains.id
  GROUP BY domains.id ORDER BY domains.hostname
`);

const findDomain = db.prepare('SELECT * FROM domains WHERE id = ?');

const findDomainByName = db.prepare('SELECT id FROM domains WHERE hostname = ?');

const insertDomain = db.prepare('INSERT INTO domains (hostname, connection, https) VALUES (?, ?, ?)');

const deleteDomain = db.prepare('DELETE FROM domains WHERE id = ?');

const countDomainLinks = db.prepare('SELECT COUNT(*) AS count FROM links WHERE domain_id = ?');

const recordDomainCheck = db.prepare('UPDATE domains SET checked_at = ?, check_error = ? WHERE id = ?');

const readSetting = db.prepare('SELECT value FROM settings WHERE key = ?');

const writeSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');

const removeSetting = db.prepare('DELETE FROM settings WHERE key = ?');

const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');

const deleteOtherSessions = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?');

function getSetting(key) {
  const row = readSetting.get(key);
  return row ? row.value : null;
}

function defaultDomainId() {
  const id = Number(getSetting('default_domain_id'));
  return id && findDomain.get(id) ? id : null;
}

const INSTANCE_ID = getSetting('instance_id') || crypto.randomBytes(16).toString('hex');

writeSetting.run('instance_id', INSTANCE_ID);

const analytics = createAnalytics(db, { getSetting, writeSetting });

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
`);

const insertApiKey = db.prepare('INSERT INTO api_keys (name, key_hash, created_at) VALUES (?, ?, ?)');

const listApiKeys = db.prepare('SELECT id, name, created_at, last_used_at FROM api_keys ORDER BY id DESC');

const findApiKey = db.prepare('SELECT id FROM api_keys WHERE key_hash = ?');

const touchApiKey = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');

const deleteApiKey = db.prepare('DELETE FROM api_keys WHERE id = ?');

const LINK_IS_EXPIRED = '((links.expires_at IS NOT NULL AND links.expires_at <= :now) OR (links.click_limit IS NOT NULL AND links.uses >= links.click_limit))';

const LINK_FILTER = `
  (:like IS NULL OR links.slug LIKE :like ESCAPE '\\' OR links.url LIKE :like ESCAPE '\\'
    OR links.content LIKE :like ESCAPE '\\' OR links.file_name LIKE :like ESCAPE '\\')
  AND (:kind IS NULL OR links.kind = :kind)
  AND (:tag IS NULL OR EXISTS (SELECT 1 FROM link_tags WHERE link_tags.link_id = links.id AND link_tags.tag = :tag))
  AND (:state IS NULL
    OR (:state = 'expired' AND ${LINK_IS_EXPIRED})
    OR (:state = 'active' AND NOT ${LINK_IS_EXPIRED})
    OR (:state = 'pin' AND links.pin_hash IS NOT NULL))
`;

const countFilteredLinks = db.prepare(`SELECT COUNT(*) AS count FROM links WHERE ${LINK_FILTER}`);

const LINK_ORDERS = { newest: 'links.id DESC', oldest: 'links.id ASC', clicks: 'clicks DESC, links.id DESC', slug: 'links.slug ASC' };

const listLinks = Object.fromEntries(Object.entries(LINK_ORDERS).map(([sort, order]) => [sort, db.prepare(`
  SELECT ${LINK_COLUMNS}, COALESCE(SUM(link_clicks.count), 0) AS clicks
  FROM links LEFT JOIN link_clicks ON link_clicks.link_id = links.id
  WHERE ${LINK_FILTER}
  GROUP BY links.id ORDER BY ${order} LIMIT :limit OFFSET :offset
`)]));

const exportLinks = db.prepare(`
  SELECT ${LINK_COLUMNS}, COALESCE(SUM(link_clicks.count), 0) AS clicks
  FROM links LEFT JOIN link_clicks ON link_clicks.link_id = links.id
  WHERE ${LINK_FILTER}
  GROUP BY links.id ORDER BY links.id DESC
`);

const countLinks = db.prepare('SELECT COUNT(*) AS count FROM links');

const recentLinks = db.prepare(`
  SELECT ${LINK_COLUMNS}, COALESCE(SUM(link_clicks.count), 0) AS clicks
  FROM links LEFT JOIN link_clicks ON link_clicks.link_id = links.id
  GROUP BY links.id ORDER BY links.id DESC LIMIT ?
`);

const topLinks = db.prepare(`
  SELECT links.slug, SUM(link_clicks.count) AS clicks
  FROM links JOIN link_clicks ON link_clicks.link_id = links.id
  GROUP BY links.id ORDER BY clicks DESC, links.id DESC LIMIT ?
`);

const countLinksSince = db.prepare('SELECT COUNT(*) AS count FROM links WHERE created_at >= ?');

const countClicks = db.prepare('SELECT COALESCE(SUM(count), 0) AS count FROM link_clicks');

const clicksByDay = db.prepare('SELECT day, SUM(count) AS count FROM link_clicks WHERE day >= ? GROUP BY day');

const recordClick = db.prepare(`
  INSERT INTO link_clicks (link_id, day, count) VALUES (?, ?, 1)
  ON CONFLICT (link_id, day) DO UPDATE SET count = count + 1
`);

module.exports = {
  FILES_DIR,
  INSTANCE_ID,
  LINK_ORDERS,
  TLS_CERT_PATH,
  TLS_KEY_PATH,
  analytics,
  clicksByDay,
  consumeUse,
  countClicks,
  countDomainLinks,
  countFilteredLinks,
  countLinks,
  countLinksSince,
  countUsers,
  db,
  defaultDomainId,
  deleteApiKey,
  deleteDomain,
  deleteExpiredSessions,
  deleteLink,
  deleteOtherSessions,
  deleteSession,
  deleteTag,
  exportLinks,
  findApiKey,
  findDomain,
  findDomainByName,
  findLink,
  findLinkById,
  findLinkText,
  findSessionUser,
  findUser,
  getSetting,
  insertApiKey,
  insertDomain,
  insertLink,
  insertSession,
  insertTag,
  insertUser,
  linkClicksByDay,
  listApiKeys,
  listDomains,
  listLinks,
  listTags,
  recentLinks,
  recordClick,
  recordDomainCheck,
  removeSetting,
  storageTotals,
  topLinks,
  touchApiKey,
  updateLinkDomain,
  updateLinkExpiry,
  updateLinkLimit,
  updateLinkPin,
  updateLinkSlug,
  updateLinkTarget,
  updatePassword,
  writeSetting,
};
