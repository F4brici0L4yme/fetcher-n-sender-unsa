#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(REPO_ROOT, '.env');
const RUNTIME_URL_FILE = path.join(REPO_ROOT, '.runtime-panel-url');
const INBOX_DIR = path.join(REPO_ROOT, 'entregas');

function fail(message, code = 1) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

function readEnvFile(filePath) {
  const values = new Map();
  if (!fs.existsSync(filePath)) return values;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const idx = normalized.indexOf('=');
    if (idx <= 0) continue;
    const key = normalized.slice(0, idx).trim();
    let value = normalized.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1).trim();
    } else {
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    values.set(key, value);
  }
  return values;
}

function resolveSetting(key, envValues, fallback) {
  const fromProcess = process.env[key]?.trim();
  if (fromProcess) return fromProcess;
  const fromFile = envValues.get(key)?.trim();
  if (fromFile) return fromFile;
  return fallback;
}

function parsePort(raw, label) {
  const trimmed = String(raw ?? '').trim();
  const parsed = /^\d{1,5}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    fail(`Invalid ${label} port value: ${raw}`);
  }
  return parsed;
}

function ensureDockerAvailable() {
  const versionCheck = spawnSync('docker', ['--version'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (versionCheck.error || versionCheck.status !== 0) {
    fail('Docker CLI with Docker Compose is required to start the application.');
  }

  const daemonCheck = spawnSync('docker', ['info'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (daemonCheck.error || daemonCheck.status !== 0) {
    fail('Docker daemon is not running or is not reachable. Start Docker Desktop / Docker Engine and retry.');
  }
}

function readOwnComposePort(containerPort, env) {
  const result = spawnSync('docker', ['compose', 'port', 'app', String(containerPort)], {
    cwd: REPO_ROOT,
    env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const firstLine = (result.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!firstLine) return null;
  const colonIdx = firstLine.lastIndexOf(':');
  if (colonIdx < 0) return null;
  const portText = firstLine.slice(colonIdx + 1).trim();
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number.parseInt(portText, 10);
  return port >= 1 && port <= 65535 ? port : null;
}

function isLoopbackPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(startPort, ownPort, excludePort) {
  const maxPort = Math.min(startPort + 200, 65535);
  for (let port = startPort; port <= maxPort; port += 1) {
    if (excludePort !== null && port === excludePort) continue;
    if (ownPort !== null && port === ownPort) return port;
    if (await isLoopbackPortFree(port)) return port;
  }
  fail(`Could not find a free loopback port on 127.0.0.1 starting from ${startPort}.`);
}

function writeRuntimePanelUrl(appPublicUrl) {
  const suffix = crypto.randomBytes(6).toString('hex');
  const tmpFile = path.join(REPO_ROOT, `.runtime-panel-url.tmp.${suffix}`);
  try {
    fs.writeFileSync(tmpFile, `${appPublicUrl}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') {
      fs.chmodSync(tmpFile, 0o600);
    }
    fs.renameSync(tmpFile, RUNTIME_URL_FILE);
  } catch (error) {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      // Ignore cleanup errors so the original error is preserved.
    }
    throw error;
  }
}

async function main() {
  ensureDockerAvailable();

  const envValues = readEnvFile(ENV_FILE);
  const composeProjectName = resolveSetting('COMPOSE_PROJECT_NAME', envValues, '');
  const requestedAppPort = parsePort(resolveSetting('APP_PORT', envValues, '3000'), 'APP_PORT');
  const requestedViewerPort = parsePort(resolveSetting('LOGIN_VIEWER_PORT', envValues, '6080'), 'LOGIN_VIEWER_PORT');

  const baseEnv = { ...process.env };
  if (composeProjectName) {
    baseEnv.COMPOSE_PROJECT_NAME = composeProjectName;
  }

  const ownAppPort = readOwnComposePort(3000, baseEnv);
  const ownViewerPort = readOwnComposePort(6080, baseEnv);

  const selectedAppPort = await findFreePort(requestedAppPort, ownAppPort, null);
  const selectedViewerPort = await findFreePort(requestedViewerPort, ownViewerPort, selectedAppPort);

  if (selectedAppPort !== requestedAppPort) {
    process.stdout.write(`Port ${requestedAppPort} is busy on 127.0.0.1; using free port ${selectedAppPort} for the panel.\n`);
  }
  if (selectedViewerPort !== requestedViewerPort) {
    process.stdout.write(`Port ${requestedViewerPort} is busy on 127.0.0.1; using free port ${selectedViewerPort} for the login viewer.\n`);
  }

  const appPublicUrl = `http://127.0.0.1:${selectedAppPort}`;
  const composeEnv = {
    ...baseEnv,
    APP_PORT: String(selectedAppPort),
    LOGIN_VIEWER_PORT: String(selectedViewerPort),
    APP_PUBLIC_URL: appPublicUrl,
  };

  fs.mkdirSync(INBOX_DIR, { recursive: true });

  const extraArgs = process.argv.slice(2);
  const noBuild = extraArgs.includes('--no-build');
  const forwardedArgs = extraArgs.filter((arg) => arg !== '--no-build');
  const composeArgs = noBuild
    ? ['compose', 'up', '-d', '--no-build', '--wait', ...forwardedArgs]
    : ['compose', 'up', '-d', '--build', '--wait', ...forwardedArgs];

  const upResult = spawnSync('docker', composeArgs, {
    cwd: REPO_ROOT,
    env: composeEnv,
    stdio: 'inherit',
  });
  if (upResult.error) {
    fail(`Failed to run docker compose: ${upResult.error.message}`);
  }
  if (upResult.status !== 0) {
    process.exit(upResult.status ?? 1);
  }

  writeRuntimePanelUrl(appPublicUrl);

  process.stdout.write(`\nActive local panel:      ${appPublicUrl}\n`);
  process.stdout.write(`Agent / Harness:         ${appPublicUrl}/agente\n`);
  process.stdout.write(`MCP (HTTP · Docker):     ${appPublicUrl}/mcp\n`);
  process.stdout.write(`Temporary login viewer:  http://127.0.0.1:${selectedViewerPort}\n`);
  process.stdout.write('Updated file:            .runtime-panel-url (automatic MCP/CLI discovery)\n');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
