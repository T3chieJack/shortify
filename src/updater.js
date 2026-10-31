'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DATA_DIR, UPDATER_DIR, UPDATER_HEARTBEAT_MS, UPDATE_REQUEST_FILE, UPDATE_STATUS_FILE } = require('./config');

const SOCKET_PATH = '/var/run/docker.sock';
const POLL_MS = 5000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 120 * 1000;
const STOP_SECONDS = 15;
const SERVICE_NAME = 'shortify';
const VERSION_LABEL = 'org.opencontainers.image.version';
const IMAGE_DEFAULT_KEYS = ['Cmd', 'Entrypoint', 'ExposedPorts', 'Healthcheck', 'OnBuild', 'Shell', 'StopSignal', 'User', 'Volumes', 'WorkingDir'];

const status = { state: 'idle', message: '', currentVersion: null, latestVersion: null, updateAvailable: false, checkedAt: null, updatedAt: null, heartbeat: 0 };

let lastCheck = 0;

let busy = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeStatus(changes = {}) {
  Object.assign(status, changes, { heartbeat: Date.now() });
  const temporary = path.join(UPDATER_DIR, `${UPDATE_STATUS_FILE}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(status));
  fs.renameSync(temporary, path.join(UPDATER_DIR, UPDATE_STATUS_FILE));
}

function docker(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {};
    const req = http.request({ socketPath: SOCKET_PATH, method, path: apiPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          let message = text;
          try {
            message = JSON.parse(text).message;
          } catch {
          }
          reject(Object.assign(new Error(message), { statusCode: res.statusCode }));
          return;
        }
        resolve(text);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function dockerJson(method, apiPath, body) {
  return JSON.parse(await docker(method, apiPath, body));
}

function inspectContainer(id) {
  return dockerJson('GET', `/containers/${encodeURIComponent(id)}/json`);
}

function inspectImage(id) {
  return dockerJson('GET', `/images/${encodeURIComponent(id)}/json`);
}

async function inspectIfPresent(id) {
  try {
    return await inspectContainer(id);
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

function ownContainer() {
  return inspectContainer(process.env.HOSTNAME);
}

async function findTarget(self) {
  const project = self.Config.Labels['com.docker.compose.project'];
  if (!project) throw new Error('Run the updater with Docker Compose, in the same file as Shortify.');
  const filters = { label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${SERVICE_NAME}`] };
  const [found] = await dockerJson('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`);
  if (!found) throw new Error(`There's no "${SERVICE_NAME}" service in this Compose project.`);
  return inspectContainer(found.Id);
}

async function pullImage(ref) {
  const output = await docker('POST', `/images/create?fromImage=${encodeURIComponent(ref)}`);
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.error) throw new Error(event.error);
  }
  return inspectImage(ref);
}

function imageVersion(image) {
  return (image.Config.Labels || {})[VERSION_LABEL] || null;
}

function configForNewImage(container, oldImage, ref) {
  const old = oldImage ? oldImage.Config : {};
  const config = { ...container.Config, Image: ref };
  config.Env = (config.Env || []).filter((entry) => !(old.Env || []).includes(entry));
  config.Labels = Object.fromEntries(Object.entries(config.Labels || {}).filter(([name, value]) => (old.Labels || {})[name] !== value));
  for (const key of IMAGE_DEFAULT_KEYS) {
    if (JSON.stringify(config[key]) === JSON.stringify(old[key])) delete config[key];
  }
  if (container.Id.startsWith(config.Hostname)) delete config.Hostname;
  return config;
}

function networkingFor(container) {
  const shortId = container.Id.slice(0, 12);
  const endpoints = Object.entries(container.NetworkSettings.Networks).map(([name, network]) => [name, {
    Aliases: (network.Aliases || []).filter((alias) => alias !== shortId),
    IPAMConfig: network.IPAMConfig,
  }]);
  return { EndpointsConfig: Object.fromEntries(endpoints) };
}

async function createFrom(container, oldImage, ref, name) {
  const body = { ...configForNewImage(container, oldImage, ref), HostConfig: container.HostConfig, NetworkingConfig: networkingFor(container) };
  const { Id } = await dockerJson('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
  return Id;
}

async function waitUntilHealthy(id) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { State, RestartCount } = await inspectContainer(id);
    if (RestartCount > 0 || !State.Running) throw new Error('The new version stopped straight after starting.');
    if (!State.Health) return;
    if (State.Health.Status === 'healthy') return;
    if (State.Health.Status === 'unhealthy') throw new Error('The new version failed its health check.');
    await delay(2000);
  }
  throw new Error('The new version took too long to become healthy.');
}

async function removeImageQuietly(id) {
  try {
    await docker('DELETE', `/images/${encodeURIComponent(id)}`);
  } catch {
  }
}

async function replaceTarget(target, ref, newImage) {
  const name = target.Name.slice(1);
  const oldName = `${name}-old`;
  const oldImage = await inspectImage(target.Image).catch(() => null);
  await docker('POST', `/containers/${target.Id}/stop?t=${STOP_SECONDS}`);
  await docker('POST', `/containers/${target.Id}/rename?name=${encodeURIComponent(oldName)}`);
  let replacement = null;
  try {
    replacement = await createFrom(target, oldImage, ref, name);
    await docker('POST', `/containers/${replacement}/start`);
    await waitUntilHealthy(replacement);
  } catch (error) {
    if (replacement) await docker('DELETE', `/containers/${replacement}?force=1`).catch(() => {});
    await docker('POST', `/containers/${target.Id}/rename?name=${encodeURIComponent(name)}`);
    await docker('POST', `/containers/${target.Id}/start`);
    await removeImageQuietly(newImage.Id);
    throw error;
  }
  await docker('DELETE', `/containers/${target.Id}`);
  await removeImageQuietly(target.Image);
}

async function replaceSelf(self) {
  const ref = self.Config.Image;
  const image = await pullImage(ref);
  if (image.Id === self.Image) return;
  const name = self.Name.slice(1);
  const oldName = `${name}-old`;
  const oldImage = await inspectImage(self.Image).catch(() => null);
  await docker('POST', `/containers/${self.Id}/rename?name=${encodeURIComponent(oldName)}`);
  let replacement = null;
  try {
    replacement = await createFrom(self, oldImage, ref, name);
    await docker('POST', `/containers/${replacement}/start`);
    await delay(HEALTH_TIMEOUT_MS);
    throw new Error('The new updater did not take over.');
  } catch (error) {
    if (replacement) await docker('DELETE', `/containers/${replacement}?force=1`).catch(() => {});
    await docker('POST', `/containers/${self.Id}/rename?name=${encodeURIComponent(name)}`);
    throw error;
  }
}

async function recoverFromInterruptedUpdate(self) {
  const ownName = self.Name.slice(1);
  if (ownName.endsWith('-old')) return;
  const previousSelf = await inspectIfPresent(`${ownName}-old`);
  if (previousSelf) {
    await docker('DELETE', `/containers/${previousSelf.Id}?force=1`);
    await removeImageQuietly(previousSelf.Image);
  }
  const target = await findTarget(self).catch(() => null);
  if (!target) return;
  const targetName = target.Name.endsWith('-old') ? target.Name.slice(1, -4) : target.Name.slice(1);
  const leftover = await inspectIfPresent(`${targetName}-old`);
  if (!leftover) return;
  const current = await inspectIfPresent(targetName);
  if (current) {
    await docker('DELETE', `/containers/${leftover.Id}?force=1`);
    return;
  }
  await docker('POST', `/containers/${leftover.Id}/rename?name=${encodeURIComponent(targetName)}`);
  await docker('POST', `/containers/${leftover.Id}/start`);
}

async function check() {
  const self = await ownContainer();
  const target = await findTarget(self);
  const current = await inspectImage(target.Image);
  writeStatus({ state: 'checking', message: '', currentVersion: imageVersion(current) });
  const latest = await pullImage(target.Config.Image);
  lastCheck = Date.now();
  writeStatus({
    state: 'idle',
    currentVersion: imageVersion(current),
    latestVersion: imageVersion(latest),
    updateAvailable: latest.Id !== target.Image,
    checkedAt: Date.now(),
  });
  return { self, target, latest };
}

async function update() {
  const { self, target, latest } = await check();
  if (latest.Id !== target.Image) {
    writeStatus({ state: 'updating', message: '' });
    await replaceTarget(target, target.Config.Image, latest);
    writeStatus({ state: 'idle', message: `Updated to ${imageVersion(latest) || 'the latest version'}.`, currentVersion: imageVersion(latest), updateAvailable: false, updatedAt: Date.now() });
  }
  await replaceSelf(self);
}

async function run(action) {
  busy = true;
  try {
    await (action === 'update' ? update() : check());
  } catch (error) {
    lastCheck = Date.now();
    writeStatus({ state: 'failed', message: error.message });
    console.error(error.message);
  } finally {
    busy = false;
  }
}

function takeRequest() {
  const file = path.join(UPDATER_DIR, UPDATE_REQUEST_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
    fs.rmSync(file, { force: true });
    return JSON.parse(text).action;
  } catch {
    return null;
  }
}

async function poll() {
  if (busy) return;
  const action = takeRequest();
  if (action === 'check' || action === 'update') await run(action);
  else if (Date.now() - lastCheck > CHECK_EVERY_MS) await run('check');
}

(async () => {
  fs.mkdirSync(UPDATER_DIR, { recursive: true });
  const { uid, gid } = fs.statSync(DATA_DIR);
  fs.chownSync(UPDATER_DIR, uid, gid);
  writeStatus();
  setInterval(writeStatus, UPDATER_HEARTBEAT_MS);
  try {
    await recoverFromInterruptedUpdate(await ownContainer());
  } catch (error) {
    writeStatus({ state: 'failed', message: error.message });
    console.error(error.message);
  }
  console.log('Shortify updater running');
  await poll();
  setInterval(poll, POLL_MS);
})();

process.on('SIGTERM', () => process.exit(0));
