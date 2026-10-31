'use strict';

const { DAY_SECONDS } = require('./config');

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function dayString(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatCount(count) {
  return count.toLocaleString('en-US');
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function plural(count, word) {
  return `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`;
}

function optionsHtml(labels, current) {
  return Object.entries(labels).map(([value, label]) => `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`).join('');
}

function formatLongDate(date) {
  const options = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (date.getUTCFullYear() !== new Date().getUTCFullYear()) options.year = 'numeric';
  return date.toLocaleDateString('en-US', options);
}

function detailRow(label, value) {
  return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

module.exports = {
  dayString,
  detailRow,
  formatBytes,
  formatCount,
  formatDate,
  formatLongDate,
  nowSeconds,
  optionsHtml,
  plural,
};
