'use strict';

const path = require('node:path');

const PORT = Number(process.env.PORT || 8080);

const HTTPS_PORT = Number(process.env.SHORTIFY_HTTPS_PORT || 8443);

const HTTPS_PUBLIC_PORT = Number(process.env.SHORTIFY_HTTPS_PUBLIC_PORT || 443);

const ROOT_DIR = path.join(__dirname, '..');

const DATA_DIR = process.env.SHORTIFY_DATA_DIR || path.join(ROOT_DIR, 'data');

const ADMIN_USERNAME = process.env.SHORTIFY_ADMIN_USERNAME || 'admin';

const SECURE_COOKIES = process.env.SHORTIFY_SECURE_COOKIES === '1';

const SESSION_COOKIE = 'shortify_session';

const CSRF_COOKIE = 'shortify_csrf';

const TWO_FACTOR_COOKIE = 'shortify_2fa';

const PENDING_LOGIN_MS = 5 * 60 * 1000;

const ENROLLMENT_MS = 15 * 60 * 1000;

const TOTP_DIGITS = 6;

const TOTP_STEP_SECONDS = 30;

const TOTP_DRIFT_STEPS = 1;

const RECOVERY_CODE_COUNT = 10;

const APP_VERSION = require('../package.json').version;

const UPDATER_DIR = path.join(DATA_DIR, 'updater');

const UPDATE_REQUEST_FILE = 'request.json';

const UPDATE_STATUS_FILE = 'status.json';

const UPDATER_HEARTBEAT_MS = 10 * 1000;

const UPDATER_STALE_MS = 60 * 1000;

const UPDATE_SCHEDULE_LABELS = { '': 'Off', daily: 'Every day', weekly: 'Every Sunday' };

const UPDATE_WEEKLY_DAY = 'Sun';

const DAY_SECONDS = 24 * 60 * 60;

const SESSION_SECONDS = DAY_SECONDS;

const REMEMBER_SECONDS = 30 * DAY_SECONDS;

const MAX_FAILED_LOGINS = 5;

const LOCKOUT_MS = 15 * 60 * 1000;

const MAX_BODY_BYTES = 8 * 1024;

const MAX_CERTIFICATE_BODY_BYTES = 128 * 1024;

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

const PAGE_EXPIRED = 'This page expired. Go back, reload, and try again.';

const MAX_URL_LENGTH = 2048;

const MAX_TEXT_BYTES = 1024 * 1024;

const MAX_FILE_NAME_LENGTH = 255;

const MAX_UPLOAD_MB = Number(process.env.SHORTIFY_MAX_UPLOAD_MB || 100);

const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const MAX_CREATE_REQUEST_BYTES = MAX_UPLOAD_BYTES + MAX_TEXT_BYTES + 64 * 1024;

const LINK_KINDS = ['url', 'text', 'file'];

const LINKS_PER_PAGE = 50;

const MAX_BULK_LINES = 200;

const MAX_BULK_BODY_BYTES = 512 * 1024;

const MAX_QUERY_LENGTH = 200;

const PIN_PATTERN = /^\d{4,12}$/;

const PIN_ERROR = 'Use 4 to 12 digits.';

const MAX_PIN_TRIES_PER_VISITOR = 5;

const MAX_PIN_TRIES_PER_LINK = 50;
const MAX_MISSED_LINKS = 200;

const MIN_PASSWORD_LENGTH = 12;

const MAX_API_BODY_BYTES = MAX_TEXT_BYTES + 64 * 1024;

const MAX_API_KEY_NAME_LENGTH = 60;

const API_PAGE_SIZE = 100;

const RECENT_VISITS = 15;

const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}$/;

const MAX_TAGS = 10;

const MAX_CLICK_LIMIT = 1000000;

const EXPIRY_PRESETS = { '1h': 60 * 60, '1d': 24 * 60 * 60, '7d': 7 * 24 * 60 * 60, '30d': 30 * 24 * 60 * 60 };

const EXPIRY_LABELS = { '': 'Never', '1h': 'In 1 hour', '1d': 'In 1 day', '7d': 'In 7 days', '30d': 'In 30 days', date: 'On a date' };

const STATE_LABELS = { '': 'Any status', active: 'Active', expired: 'Expired', pin: 'Has a PIN' };

const RETENTION_LABELS = { 30: '30 days', 90: '90 days', 180: '180 days', 365: '1 year' };

const RANGE_DAYS = [7, 30, 90, 180, 365];

const HEATMAP_ROW_HEIGHT = 22;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

const DOMAIN_CHECK_TIMEOUT_MS = 5000;

const CURRENT_ADDRESS = 'current';

const CONNECTION_LABELS = { direct: 'Direct to this server', tunnel: 'Cloudflare Tunnel', proxy: 'My own reverse proxy' };

const SETTINGS_NOTICES = {
  'domain-added': 'Domain added. Use Check to confirm it reaches this server.',
  'domain-checked': 'Domain checked.',
  'domain-removed': 'Domain removed.',
  'default-changed': 'Default domain changed.',
  'tunnel-saved': 'Tunnel saved. It can take a few seconds to connect, so reload to see its status.',
  'tunnel-removed': 'Tunnel disconnected and its token removed.',
  'proxies-saved': 'Reverse proxy addresses saved.',
  'password-changed': 'Password changed. Other devices have been logged out.',
  '2fa-expired': 'Setup took too long, so nothing changed. Start again.',
  '2fa-off': 'Two-factor login turned off.',
  'update-started': 'Update started. Shortify will restart when it has downloaded the new version, so reload this page in a minute or two.',
  'update-checking': 'Checking for updates. Reload this page in a moment.',
  'update-schedule-saved': 'Update schedule saved.',
  'advanced-saved': 'Advanced mode settings saved.',
  'stats-cleared': 'Detailed stats deleted.',
  'key-removed': 'API key revoked. Anything using it has stopped working.',
  'https-saved': 'HTTPS settings saved.',
  'https-removed': 'HTTPS certificate removed. Shortify now answers over HTTP only.',
};

const KIND_LABELS = { url: 'Links', text: 'Text', file: 'Files' };

const SORT_LABELS = { newest: 'Newest first', oldest: 'Oldest first', clicks: 'Most clicks', slug: 'Ending, A to Z' };

const RECENT_LINKS = 10;

const TOP_LINKS = 5;

const CHART_DAYS = 30;

const CHART_PLOT_HEIGHT = 190;

const CHART_HEIGHT = CHART_PLOT_HEIGHT + 26;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const RESERVED_SLUGS = new Set(['admin', 'analytics', 'api', 'assets', 'dashboard', 'healthz', 'links', 'login', 'logout', 'settings', 'setup', 'static']);

const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const SLUG_LENGTH = 6;

module.exports = {
  MAX_MISSED_LINKS,
  ADMIN_USERNAME,
  API_PAGE_SIZE,
  APP_VERSION,
  CHART_DAYS,
  CHART_HEIGHT,
  CHART_PLOT_HEIGHT,
  CONNECTION_LABELS,
  COUNTRY_NAMES,
  CSRF_COOKIE,
  CURRENT_ADDRESS,
  DATA_DIR,
  DAY_SECONDS,
  DOMAIN_CHECK_TIMEOUT_MS,
  ENROLLMENT_MS,
  EXPIRY_LABELS,
  EXPIRY_PRESETS,
  HEATMAP_ROW_HEIGHT,
  HTTPS_PORT,
  HTTPS_PUBLIC_PORT,
  KIND_LABELS,
  LANGUAGE_NAMES,
  LINKS_PER_PAGE,
  LINK_KINDS,
  LOCKOUT_MS,
  MAX_API_BODY_BYTES,
  MAX_API_KEY_NAME_LENGTH,
  MAX_BODY_BYTES,
  MAX_BULK_BODY_BYTES,
  MAX_BULK_LINES,
  MAX_CERTIFICATE_BODY_BYTES,
  MAX_CLICK_LIMIT,
  MAX_CREATE_REQUEST_BYTES,
  MAX_FAILED_LOGINS,
  MAX_FILE_NAME_LENGTH,
  MAX_PIN_TRIES_PER_LINK,
  MAX_PIN_TRIES_PER_VISITOR,
  MAX_QUERY_LENGTH,
  MAX_TAGS,
  MAX_TEXT_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  MAX_URL_LENGTH,
  MIN_PASSWORD_LENGTH,
  PAGE_EXPIRED,
  PENDING_LOGIN_MS,
  PIN_ERROR,
  PIN_PATTERN,
  PORT,
  RANGE_DAYS,
  RECENT_LINKS,
  RECENT_VISITS,
  RECOVERY_CODE_COUNT,
  REMEMBER_SECONDS,
  RESERVED_SLUGS,
  RETENTION_LABELS,
  ROOT_DIR,
  SECURE_COOKIES,
  SESSION_COOKIE,
  SESSION_SECONDS,
  SETTINGS_NOTICES,
  SLUG_ALPHABET,
  SLUG_LENGTH,
  SLUG_PATTERN,
  SORT_LABELS,
  STATE_LABELS,
  TAG_PATTERN,
  TOP_LINKS,
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  TOTP_STEP_SECONDS,
  TWO_FACTOR_COOKIE,
  UPDATER_DIR,
  UPDATER_HEARTBEAT_MS,
  UPDATER_STALE_MS,
  UPDATE_REQUEST_FILE,
  UPDATE_SCHEDULE_LABELS,
  UPDATE_STATUS_FILE,
  UPDATE_WEEKLY_DAY,
  USERNAME_PATTERN,
  WEEKDAYS,
};
