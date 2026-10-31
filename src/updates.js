'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { UPDATER_DIR, UPDATER_STALE_MS, UPDATE_REQUEST_FILE, UPDATE_SCHEDULE_LABELS, UPDATE_STATUS_FILE, UPDATE_WEEKLY_DAY } = require('./config');
const { analytics, getSetting, writeSetting } = require('./db');

const SCHEDULE_CHECK_MS = 60 * 1000;

function readStatus() {
  try {
    const status = JSON.parse(fs.readFileSync(path.join(UPDATER_DIR, UPDATE_STATUS_FILE), 'utf8'));
    return Date.now() - status.heartbeat < UPDATER_STALE_MS ? status : null;
  } catch {
    return null;
  }
}

function requestAction(action) {
  fs.mkdirSync(UPDATER_DIR, { recursive: true });
  const temporary = path.join(UPDATER_DIR, `${UPDATE_REQUEST_FILE}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify({ action }));
  fs.renameSync(temporary, path.join(UPDATER_DIR, UPDATE_REQUEST_FILE));
}

function currentSchedule() {
  const schedule = getSetting('update_schedule');
  const hour = Number(getSetting('update_hour'));
  return {
    schedule: Object.hasOwn(UPDATE_SCHEDULE_LABELS, schedule ?? '') ? schedule : '',
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3,
  };
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return { day: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')), weekday: value('weekday') };
}

function updateIsDue(schedule, hour, last, { day, hour: localHour, weekday }) {
  if (!schedule || localHour !== hour || last === day) return false;
  return schedule === 'daily' || (schedule === 'weekly' && weekday === UPDATE_WEEKLY_DAY);
}

function checkSchedule() {
  const { schedule, hour } = currentSchedule();
  const parts = localParts(new Date(), analytics.timeZone());
  if (!updateIsDue(schedule, hour, getSetting('update_last_run'), parts) || !readStatus()) return;
  writeSetting.run('update_last_run', parts.day);
  requestAction('update');
}

function startUpdateSchedule() {
  setInterval(checkSchedule, SCHEDULE_CHECK_MS).unref();
}

module.exports = {
  currentSchedule,
  readStatus,
  requestAction,
  startUpdateSchedule,
};
