#!/usr/bin/env node
/**
 * Dedicated Workerd API launcher for Playwright.
 *
 * Guarantees:
 * - listens on the E2E-only port (default 18787), never :8787
 * - persists only under .playwright/wrangler-state, never apps/api/.wrangler
 * - initializes a fresh D1 database (migrations 0001-0017 + seed-local.sql)
 * - overrides every connection-sensitive var even when apps/api/.dev.vars exists
 * - refuses to start (and never deletes state) when the target port is occupied
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const apiDir = path.join(repoRoot, 'apps', 'api');
const apiPort = Number(process.env.E2E_API_PORT ?? 18787);
const inspectorPort = Number(process.env.E2E_INSPECTOR_PORT ?? 19229);
const webPort = Number(process.env.E2E_WEB_PORT ?? 13000);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? `http://localhost:${webPort}`;
const stateDir = path.resolve(
  process.env.E2E_PERSIST_DIR ??
    path.join(repoRoot, '.playwright', 'wrangler-state')
);
const wranglerBin = path.join(
  apiDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
);

function fail(message) {
  console.error(`[e2e-api] ${message}`);
  process.exit(1);
}

function assertSafeStateDir(dir) {
  if (dir === path.parse(dir).root || dir === repoRoot || dir === apiDir) {
    fail(`Refusing to reset unsafe persistence directory: ${dir}`);
  }
  if (!fs.existsSync(wranglerBin)) {
    fail(`wrangler binary not found at ${wranglerBin}. Run pnpm install first.`);
  }
}

function assertPortFree(port, label) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `${label} port ${port} is already in use. ` +
              `Stop the E2E server using it or set E2E_API_PORT/E2E_INSPECTOR_PORT. ` +
              `The existing process was not touched.`
          )
        );
        return;
      }
      reject(err);
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(port, '127.0.0.1');
  });
}

function runWrangler(args, input) {
  const result = spawnSync(wranglerBin, args, {
    cwd: apiDir,
    env: process.env,
    stdio: input ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    input,
    encoding: 'utf8',
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`wrangler ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

assertSafeStateDir(stateDir);

try {
  await assertPortFree(apiPort, 'API');
  await assertPortFree(inspectorPort, 'Inspector');
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true });

console.log(`[e2e-api] resetting isolated D1 state at ${stateDir}`);
runWrangler(
  [
    'd1',
    'migrations',
    'apply',
    'files-local',
    '--local',
    '--persist-to',
    stateDir,
  ],
  // Wrangler asks for confirmation only on a TTY; feeding input keeps CI stable.
  'y\n'
);
runWrangler([
  'd1',
  'execute',
  'files-local',
  '--local',
  '--persist-to',
  stateDir,
  '--file',
  'scripts/seed-local.sql',
  '--yes',
]);
console.log('[e2e-api] D1 migrations 0001-0017 + seed-local.sql applied');

const child = spawn(
  wranglerBin,
  [
    'dev',
    '--port',
    String(apiPort),
    // Collabora is a container: it cannot reach a loopback-only Wrangler.
    // Binding the E2E-only port makes host.docker.internal:18787 reachable.
    '--ip',
    '0.0.0.0',
    '--inspector-port',
    String(inspectorPort),
    '--persist-to',
    stateDir,
    '--log-level',
    'warn',
    // Command-line vars take precedence over wrangler.jsonc and .dev.vars.
    '--var',
    'ENVIRONMENT:local',
    '--var',
    'ALLOW_DEV_AUTH:true',
    '--var',
    `APP_ORIGIN:${webOrigin}`,
    '--var',
    'STORAGE_MODE:local_proxy',
    '--var',
    'DEFAULT_TENANT_ID:tenant-default',
    '--var',
    // Collabora runs inside a container; 127.0.0.1 would point at the
    // container itself. host.docker.internal reaches the macOS host Wrangler,
    // and the compose aliasgroup allowlists the same origin.
    `WOPI_HOST_ORIGIN:http://host.docker.internal:${apiPort}`,
    '--var',
    `COLLABORA_URL:${process.env.E2E_COLLABORA_URL ?? 'http://localhost:9980'}`,
  ],
  {
    cwd: apiDir,
    env: process.env,
    stdio: 'inherit',
  }
);

child.on('error', (err) => {
  fail(`failed to spawn wrangler dev: ${err.message}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, 8_000);
  forceTimer.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(0);
  }
  process.exit(code ?? 0);
});
