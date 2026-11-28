import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from './config';

test('readConfig enables browser mode when AULA_CAPTURE_MODE=browser with SESSION_DIR', () => {
  const config = readConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:pass@db:5432/fetcher',
    UPLOAD_DIR: '/data/uploads',
    SESSION_DIR: '/sessions',
    AULA_CAPTURE_MODE: 'browser',
    AULA_PORTAL_URL: 'https://aulavirtual.unsa.edu.pe/2026B/',
    AULA_ACCOUNT_ID: 'aula-unsa',
    LOGIN_VIEWER_PORT: '6080',
  });
  assert.equal(config.demoMode, false);
  assert.equal(config.assistedCapture, undefined);
  assert.deepEqual(config.personalBrowser, {
    portalUrl: 'https://aulavirtual.unsa.edu.pe/2026B/',
    profileDir: '/sessions',
    accountNamespace: 'aula-unsa',
    portalAccount: undefined,
    display: ':99',
    viewerPort: 6080,
  });
});

test('readConfig rejects combining browser mode with demo mode', () => {
  assert.throws(() => readConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:pass@db:5432/fetcher',
    UPLOAD_DIR: '/data/uploads',
    SESSION_DIR: '/sessions',
    AULA_CAPTURE_MODE: 'browser',
    DEMO_MODE: 'true',
  }), /Elige un solo modo/);
});

test('readConfig keeps assisted mode and default mode compatible', () => {
  const assisted = readConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:pass@db:5432/fetcher',
    UPLOAD_DIR: '/data/uploads',
    AULA_CAPTURE_MODE: 'assisted',
    AULA_PORTAL_ACCOUNT: 'student@unsa.edu.pe',
  });
  assert.equal(assisted.personalBrowser, undefined);
  assert.equal(assisted.assistedCapture?.portalAccount, 'student@unsa.edu.pe');
});

test('personal browser preserves custom LOGIN_VIEWER_PORT for host URL while container listens on 6080', () => {
  const cfg = readConfig({
    DATABASE_URL: 'postgresql://u:p@db:5432/fetcher',
    UPLOAD_DIR: '/data/uploads',
    SESSION_DIR: '/sessions',
    AULA_CAPTURE_MODE: 'browser',
    LOGIN_VIEWER_PORT: '6081',
  });
  assert.equal(cfg.personalBrowser?.viewerPort, 6081);
  assert.equal(cfg.autoSyncIntervalSeconds, 180);
});

test('readConfig validates AULA_AUTO_SYNC_INTERVAL_SECONDS bounds and allows disabling with 0', () => {
  const disabled = readConfig({
    DATABASE_URL: 'postgresql://u:p@db:5432/fetcher',
    UPLOAD_DIR: '/data/uploads',
    SESSION_DIR: '/sessions',
    AULA_CAPTURE_MODE: 'browser',
    AULA_AUTO_SYNC_INTERVAL_SECONDS: '0',
  });
  assert.equal(disabled.autoSyncIntervalSeconds, 0);

  const custom = readConfig({
    DATABASE_URL: 'postgresql://u:p@db:5432/fetcher',
    UPLOAD_DIR: '/data/uploads',
    SESSION_DIR: '/sessions',
    AULA_CAPTURE_MODE: 'browser',
    AULA_AUTO_SYNC_INTERVAL_SECONDS: '90',
  });
  assert.equal(custom.autoSyncIntervalSeconds, 90);

  assert.throws(() => readConfig({
    DATABASE_URL: 'postgresql://u:p@db:5432/fetcher',
    UPLOAD_DIR: '/data/uploads',
    SESSION_DIR: '/sessions',
    AULA_CAPTURE_MODE: 'browser',
    AULA_AUTO_SYNC_INTERVAL_SECONDS: '10',
  }), /AULA_AUTO_SYNC_INTERVAL_SECONDS/);
});
