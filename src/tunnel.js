'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const BINARY = process.env.CLOUDFLARED_BIN || 'cloudflared';
const METRICS_ADDRESS = '127.0.0.1:20241';
const FIRST_RETRY_MS = 5000;
const MAX_RETRY_MS = 60000;
const FATAL_ERROR = /unauthorized|invalid tunnel secret|token.*(not valid|invalid)|invalid.*token|tunnel.*not found|failed to get tunnel/i;

let child = null;
let token = null;
let wanted = false;
let retryTimer = null;
let retryDelay = FIRST_RETRY_MS;
let lastError = '';
let fatal = false;

function isInstalled() {
  const candidates = BINARY.includes('/')
    ? [BINARY]
    : (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, BINARY));
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function noteLogLine(line) {
  if (!/\bERR\b/.test(line)) return;
  lastError = line.replace(/^\S+\s+ERR\s+/, '').slice(0, 300);
  console.error(`cloudflared: ${lastError}`);
  if (FATAL_ERROR.test(line)) fatal = true;
}

function launch() {
  clearTimeout(retryTimer);
  if (!wanted || child) return;

  fatal = false;
  const started = spawn(BINARY, ['tunnel', '--no-autoupdate', '--metrics', METRICS_ADDRESS, 'run'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TUNNEL_TOKEN: token },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child = started;
  readline.createInterface({ input: started.stderr }).on('line', noteLogLine);

  started.on('error', (error) => { lastError = error.message; });
  started.on('close', () => {
    child = null;
    if (!wanted || fatal) return;
    retryTimer = setTimeout(launch, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  });
}

function start(newToken) {
  token = newToken;
  wanted = true;
  lastError = '';
  retryDelay = FIRST_RETRY_MS;
  if (child) {
    child.once('close', launch);
    child.kill('SIGTERM');
  } else {
    launch();
  }
}

function stop() {
  wanted = false;
  token = null;
  lastError = '';
  clearTimeout(retryTimer);
  if (child) child.kill('SIGTERM');
}

function kill() {
  if (child) child.kill('SIGTERM');
}

async function isReady() {
  try {
    const response = await fetch(`http://${METRICS_ADDRESS}/ready`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function status() {
  if (!wanted) return { state: 'off', error: '' };
  if (child && await isReady()) return { state: 'connected', error: '' };
  if (fatal) return { state: 'failed', error: lastError };
  return { state: 'connecting', error: lastError };
}

module.exports = { isInstalled, start, stop, kill, status };
