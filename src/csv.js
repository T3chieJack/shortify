'use strict';

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(cells) {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

function startCsv(res, name) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
}

function isoTime(seconds) {
  return seconds === null ? '' : new Date(seconds * 1000).toISOString();
}

module.exports = {
  csvRow,
  isoTime,
  startCsv,
};
