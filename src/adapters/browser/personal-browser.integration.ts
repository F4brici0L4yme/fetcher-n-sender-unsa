import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { chromium, type BrowserContext } from 'playwright';
import type { ProofStore } from '../../core/application/ports/persistence';
import { PersonalBrowser } from './personal-browser';

const portal = 'https://aula.example.invalid/2099B/';
const email = 'student@example.invalid';

test('personal browser persists isolated login, captures and delivers only authorized bytes, detects expiry', async (t) => {
  assert.ok(process.env.DATABASE_URL, 'Run in Docker with isolated PostgreSQL.');
  const url = new URL(process.env.DATABASE_URL);
  const database = 'browser_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url.href });
  await admin.query('create database ' + database);
  url.pathname = '/' + database;
  const pool = new Pool({ connectionString: url.href });
  await migrate(drizzle(pool), { migrationsFolder: 'src/adapters/persistence/migrations' });
  const root = await mkdtemp(join(tmpdir(), 'personal-browser-test-'));
  t.diagnostic('Browser scratch for parent cleanup: ' + root);
  let expired = false;
  let identity = email;
  let uploadedName = '';
  let uploadedBody = '';
  let submitted = false;
  let visible = 0;
  let viewerStops = 0;
  const headlessModes: boolean[] = [];
  const launch = async (profile: string, headless: boolean): Promise<BrowserContext> => {
    headlessModes.push(headless);
    // The fixture records the requested visible mode, but uses headless Chromium in CI.
    const context = await chromium.launchPersistentContext(profile, { headless: true, chromiumSandbox: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
    if (!headless) await context.addCookies([{ name: 'MoodleSession', value: 'synthetic-session', url: portal }]);
    await context.route('**/*', async (route) => {
      const request = route.request();
      const u = new URL(request.url());
      if (u.origin !== new URL(portal).origin) return route.abort();
      if (expired || !(await request.headerValue('cookie'))?.includes('MoodleSession=synthetic-session')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<form id="login"><input name="username"></form>' });
      let body = '';
      if (u.pathname.endsWith('/user/profile.php')) body = `<div class="userprofile"><dl><dt>Dirección de correo</dt><dd><a href="mailto:${identity}">${identity}</a></dd></dl></div>`;
      else if (u.pathname.endsWith('/mod/assign/view.php')) {
        const action = u.searchParams.get('action');
        if (request.method() === 'POST') {
          const raw = request.postData() ?? '';
          if (action === 'savesubmission') { uploadedBody = raw; uploadedName = raw.match(/filename="([^"]+)"/)?.[1] ?? ''; }
          if (action === 'submit') submitted = true;
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<body class="loggedin"><div class="usermenu"><a href="${portal}user/profile.php">Perfil</a></div></body>` });
        }
        if (action === 'editsubmission') body = `<form method="post" enctype="multipart/form-data" action="?id=3&action=savesubmission"><input type="file" name="file"><button name="submitbutton">Guardar cambios</button></form>`;
        else body = `<h1>Trabajo final</h1><nav class="breadcrumb"><a href="${portal}course/view.php?id=2">Métodos Numéricos</a></nav><div class="submissionstatustable"><table><tr><th>Estado de la entrega</th><td>${submitted ? 'Enviado para calificar' : uploadedName ? 'Borrador (no enviado)' : 'No se ha enviado nada en esta tarea'}</td></tr><tr><th>Fecha de entrega</th><td>5 de diciembre de 2099, 23:59</td></tr><tr><th>Archivos enviados</th><td>${uploadedName ? `<div class="fileuploadsubmission"><a href="${portal}pluginfile.php/3/submission/${uploadedName}">${uploadedName}</a></div>` : ''}</td></tr></table></div><a href="?id=3&action=editsubmission">Agregar entrega</a><form method="post" action="?id=3&action=submit"><button>Enviar tarea</button></form>`;
      } else if (u.pathname.includes('/pluginfile.php/')) return route.fulfill({ contentType: 'application/pdf', body: Buffer.from('%PDF-1.4 authorized') });
      else body = `<a href="${portal}mod/assign/view.php?id=3">Trabajo final</a>`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<body class="loggedin"><div class="usermenu"><a href="${portal}user/profile.php">Perfil</a></div>${body}</body>` });
    });
    return context;
  };
  const proofs = new Map<string, Uint8Array>();
  const discardedProofs: string[] = [];
  let proofCounter = 0;
  const proofStore: ProofStore = {
    async writePng(content: Uint8Array) {
      const key = `proof-${++proofCounter}.png`;
      proofs.set(key, Uint8Array.from(content));
      return key;
    },
    async readPng(storageKey: string) {
      return proofs.get(storageKey) ?? null;
    },
    async discard(storageKey: string) {
      discardedProofs.push(storageKey);
      proofs.delete(storageKey);
    },
  };
  const options = { portalUrl: portal, profileDir: join(root, 'profiles'), accountNamespace: 'personal', initialAccountId: 'initial', viewer: { async start() { visible++; }, async stop() { viewerStops++; } }, proofStore };
  const browser = new PersonalBrowser(pool, options, { launch, loginTimeoutMs: 15000, loginPollMs: 20 });
  t.after(async () => { await browser.close(); await pool.end(); await admin.query('drop database ' + database); await admin.end(); });
  await browser.initialize();
  assert.equal((await browser.status()).state, 'disconnected');
  await browser.connect(email);
  assert.equal((await browser.fetch({ jobId: 'busy', accountId: browser.current() })).kind, 'unavailable');
  const competitor = new PersonalBrowser(pool, options, { launch });
  await assert.rejects(competitor.initialize(), /instancia/);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'connected');
  const accountId = browser.current();
  assert.notEqual(accountId, 'initial');
  assert.equal(visible, 1);
  assert.equal(viewerStops, 1);
  assert.equal((await stat(options.profileDir)).mode & 0o777, 0o700);
  const capture = await browser.fetch({ jobId: 'capture', accountId });
  assert.equal(capture.kind, 'success');
  if (capture.kind !== 'success') return;
  assert.equal(capture.assignments[0]?.title, 'Trabajo final');
  assert.equal(capture.assignments[0]?.deadline, '2099-12-06T04:59:00.000Z');
  const path = join(root, 'opaque-storage-key.pdf');
  const buffer = Buffer.from('%PDF-1.4 authorized');
  await writeFile(path, buffer, { mode: 0o600 });
  const order = { accountId, jobId: 'delivery', externalId: '3', activityUrl: portal + 'mod/assign/view.php?id=3', pdfId: 'pdf', localFilePath: path, originalName: 'student-authorized.pdf', sha256: createHash('sha256').update(buffer).digest('hex') };
  assert.equal((await browser.submit({ ...order, sha256: '0'.repeat(64) })).state, 'failed');
  assert.equal(uploadedName, '');
  assert.equal(proofs.size, 0);
  const delivery = await browser.submit(order);
  assert.equal(delivery.state, 'confirmed');
  assert.ok(delivery.evidence.proofKey, 'Expected confirmed delivery to include a proofKey');
  assert.ok(
    delivery.evidence.capturedAt && !Number.isNaN(Date.parse(delivery.evidence.capturedAt)),
    'Expected confirmed delivery to include an ISO capturedAt timestamp',
  );
  const proofBytes = await proofStore.readPng(delivery.evidence.proofKey);
  assert.ok(proofBytes, 'Expected ProofStore to contain the captured proof PNG');
  assert.deepEqual(
    Array.from(proofBytes.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'Expected captured proof to begin with the PNG magic header',
  );
  assert.ok(proofBytes.byteLength > 500, `Expected proof PNG > 500 bytes, got ${proofBytes.byteLength}`);
  assert.equal(proofs.size, 1, 'Expected superseded intermediate draft proof PNGs to be cleaned up');
  assert.ok(discardedProofs.length >= 1, 'Expected superseded draft proof key to be discarded');
  assert.equal(uploadedName, order.originalName);
  assert.ok(uploadedBody.includes('%PDF-1.4 authorized'));
  assert.equal(submitted, true);
  assert.equal(headlessModes[0], false);
  assert.ok(headlessModes.slice(1).every(Boolean));
  expired = true;
  assert.equal((await browser.fetch({ jobId: 'expired', accountId })).kind, 'session_expired');
  assert.equal((await browser.status()).state, 'expired');
  const cancelledId = randomUUID();
  await pool.query("insert into jobs(id, account_id, kind, state) values($1,$2,'delivery','authorized')", [cancelledId, accountId]);
  await browser.disconnect();
  assert.equal((await pool.query('select state from jobs where id=$1', [cancelledId])).rows[0]?.state, 'failed');
  expired = false;
  identity = 'different@example.invalid';
  await browser.connect(email);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'error');
  assert.notEqual((await browser.fetch({ jobId: 'wrong', accountId })).kind, 'success');
  await browser.disconnect();
  await browser.connect(identity);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'connected');
  assert.notEqual(browser.current(), accountId);
  assert.equal((await browser.submit(order)).state, 'failed');
});

test('personal browser verifies identity via /user/edit.php fallback, mailto links, and tolerates transient empty profile pages', async (t) => {
  assert.ok(process.env.DATABASE_URL, 'Run in Docker with isolated PostgreSQL.');
  const url = new URL(process.env.DATABASE_URL);
  const database = 'browser_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url.href });
  await admin.query('create database ' + database);
  url.pathname = '/' + database;
  const pool = new Pool({ connectionString: url.href });
  await migrate(drizzle(pool), { migrationsFolder: 'src/adapters/persistence/migrations' });
  const root = await mkdtemp(join(tmpdir(), 'personal-browser-fallback-'));
  t.diagnostic('Browser scratch for parent cleanup: ' + root);

  type ProfileMode = 'hidden-edit-input' | 'hidden-edit-readonly' | 'mailto-no-dt' | 'transient-empty';
  let mode: ProfileMode = 'hidden-edit-input';
  let profileHits = 0;

  const launch = async (profile: string, headless: boolean): Promise<BrowserContext> => {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      chromiumSandbox: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    });
    if (!headless) await context.addCookies([{ name: 'MoodleSession', value: 'synthetic-session', url: portal }]);
    await context.route('**/*', async (route) => {
      const request = route.request();
      const u = new URL(request.url());
      if (u.origin !== new URL(portal).origin) return route.abort();
      if (!(await request.headerValue('cookie'))?.includes('MoodleSession=synthetic-session')) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<form id="login"><input name="username"></form>' });
      }
      let body = '';
      if (u.pathname.endsWith('/user/profile.php')) {
        profileHits += 1;
        if (mode === 'hidden-edit-input' || mode === 'hidden-edit-readonly') {
          body = '<div class="userprofile"><dl><dt>País</dt><dd>Perú</dd></dl></div>';
        } else if (mode === 'mailto-no-dt') {
          body = `<main><section><p>Contacto institucional: <a href="mailto:${email}?subject=DUTIC">Enviar correo</a></p></section></main>`;
        } else if (mode === 'transient-empty') {
          body = profileHits < 2
            ? '<div class="userprofile"><p>Cargando perfil...</p></div>'
            : `<div class="userprofile"><dl><dt>Correo electrónico</dt><dd>${email} (Solo visible para participantes)</dd></dl></div>`;
        }
      } else if (u.pathname.endsWith('/user/edit.php')) {
        if (mode === 'hidden-edit-input') {
          body = `<form><div id="fitem_id_email"><input id="id_email" name="email" type="text" value="${email}"></div></form>`;
        } else if (mode === 'hidden-edit-readonly') {
          body = `<form><div id="fitem_id_email"><div class="felement">${email}</div></div></form>`;
        } else {
          body = '<main><p>Sin correo editable</p></main>';
        }
      } else {
        body = '<main><p>Área personal</p></main>';
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<body class="loggedin"><div class="usermenu"><a href="${portal}user/profile.php">Perfil</a></div>${body}</body>`,
      });
    });
    return context;
  };

  const options = {
    portalUrl: portal,
    profileDir: join(root, 'profiles'),
    accountNamespace: 'personal-fallback',
    initialAccountId: 'initial',
    viewer: { async start() {}, async stop() {} },
  };
  const browser = new PersonalBrowser(pool, options, { launch, loginTimeoutMs: 15000, loginPollMs: 20 });
  t.after(async () => { await browser.close(); await pool.end(); await admin.query('drop database ' + database); await admin.end(); });
  await browser.initialize();

  // 1. Hidden email on /user/profile.php falls back to /user/edit.php input[name="email"], including in read-only fetch.
  mode = 'hidden-edit-input';
  await browser.connect(email);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'connected');
  const capture = await browser.fetch({ jobId: 'capture-hidden-email', accountId: browser.current() });
  assert.equal(capture.kind, 'success');
  await browser.disconnect();

  // 2. Hidden email on /user/profile.php falls back to read-only OAuth-locked #fitem_id_email .felement on /user/edit.php.
  mode = 'hidden-edit-readonly';
  await browser.connect(email);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'connected');
  await browser.disconnect();

  // 3. Profile exposing email via mailto: link without matching <dt> text.
  mode = 'mailto-no-dt';
  await browser.connect(email);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'connected');
  await browser.disconnect();

  // 4. Transient empty profile page keeps polling instead of failing with error, then connects once email renders.
  mode = 'transient-empty';
  profileHits = 0;
  await browser.connect(email);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'connected');
  assert.ok(profileHits >= 2, 'Expected transient empty profile page to trigger at least one retry');
  await browser.disconnect();
});

test('proof capture failures never break confirmed deliveries and verify captures PNG proof', async (t) => {
  assert.ok(process.env.DATABASE_URL, 'Run in Docker with isolated PostgreSQL.');
  const url = new URL(process.env.DATABASE_URL);
  const database = 'browser_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url.href });
  await admin.query('create database ' + database);
  url.pathname = '/' + database;
  const pool = new Pool({ connectionString: url.href });
  await migrate(drizzle(pool), { migrationsFolder: 'src/adapters/persistence/migrations' });
  const root = await mkdtemp(join(tmpdir(), 'personal-browser-proof-'));

  let uploadedName = '';
  let submitted = false;
  let failWrites = true;
  const proofs = new Map<string, Uint8Array>();
  let proofCounter = 0;
  const proofStore: ProofStore = {
    async writePng(content: Uint8Array) {
      if (failWrites) throw new Error('Simulated proof store write failure');
      const key = `verify-proof-${++proofCounter}.png`;
      proofs.set(key, Uint8Array.from(content));
      return key;
    },
    async readPng(storageKey: string) {
      return proofs.get(storageKey) ?? null;
    },
    async discard(storageKey: string) {
      proofs.delete(storageKey);
    },
  };

  const launch = async (profile: string, headless: boolean): Promise<BrowserContext> => {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      chromiumSandbox: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    });
    if (!headless) await context.addCookies([{ name: 'MoodleSession', value: 'synthetic-session', url: portal }]);
    await context.route('**/*', async (route) => {
      const request = route.request();
      const u = new URL(request.url());
      if (u.origin !== new URL(portal).origin) return route.abort();
      if (!(await request.headerValue('cookie'))?.includes('MoodleSession=synthetic-session')) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<form id="login"><input name="username"></form>' });
      }
      let body = '';
      if (u.pathname.endsWith('/user/profile.php')) {
        body = `<div class="userprofile"><dl><dt>Dirección de correo</dt><dd><a href="mailto:${email}">${email}</a></dd></dl></div>`;
      } else if (u.pathname.endsWith('/mod/assign/view.php')) {
        const action = u.searchParams.get('action');
        if (request.method() === 'POST') {
          const raw = request.postData() ?? '';
          if (action === 'savesubmission') uploadedName = raw.match(/filename="([^"]+)"/)?.[1] ?? '';
          if (action === 'submit') submitted = true;
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<body class="loggedin"><div class="usermenu"><a href="${portal}user/profile.php">Perfil</a></div></body>` });
        }
        if (action === 'editsubmission') {
          body = '<form method="post" enctype="multipart/form-data" action="?id=7&action=savesubmission"><input type="file" name="file"><button name="submitbutton">Guardar cambios</button></form>';
        } else {
          body = `<div id="region-main"><h1>Tarea 7</h1><div class="submissionstatustable"><table><tr><th>Estado de la entrega</th><td>${submitted ? 'Enviado para calificar' : uploadedName ? 'Borrador (no enviado)' : 'No se ha enviado nada en esta tarea'}</td></tr><tr><th>Archivos enviados</th><td>${uploadedName ? `<div class="fileuploadsubmission"><a href="${portal}pluginfile.php/7/submission/${uploadedName}">${uploadedName}</a></div>` : ''}</td></tr></table></div><form method="post" action="?id=7&action=submit"><button>Enviar tarea</button></form></div>`;
        }
      } else {
        body = `<a href="${portal}mod/assign/view.php?id=7">Tarea 7</a>`;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<body class="loggedin"><div class="usermenu"><a href="${portal}user/profile.php">Perfil</a></div>${body}</body>`,
      });
    });
    return context;
  };

  const browser = new PersonalBrowser(pool, {
    portalUrl: portal,
    profileDir: join(root, 'profiles'),
    accountNamespace: 'personal-proof',
    initialAccountId: 'initial',
    viewer: { async start() {}, async stop() {} },
    proofStore,
  }, { launch, loginTimeoutMs: 15000, loginPollMs: 20 });

  t.after(async () => {
    await browser.close();
    await pool.end();
    await admin.query('drop database ' + database);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });

  await browser.initialize();
  await browser.connect(email);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'connected');

  const pdfPath = join(root, 'authorized.pdf');
  const pdfBytes = Buffer.from('%PDF-1.4 authorized proof test');
  await writeFile(pdfPath, pdfBytes, { mode: 0o600 });
  const order = {
    accountId: browser.current(),
    jobId: 'delivery-proof-resilience',
    externalId: '7',
    activityUrl: portal + 'mod/assign/view.php?id=7',
    pdfId: 'pdf-7',
    localFilePath: pdfPath,
    originalName: 'tarea-7.pdf',
    sha256: createHash('sha256').update(pdfBytes).digest('hex'),
  };

  // Proof store failure must not break a confirmed delivery.
  const delivery = await browser.submit(order);
  assert.equal(delivery.state, 'confirmed');
  assert.equal(delivery.evidence.proofKey, undefined);
  assert.equal(proofs.size, 0);

  // Verification captures PNG proof when proof store is healthy.
  failWrites = false;
  const verified = await browser.verify(order);
  assert.equal(verified.state, 'needs_verification');
  assert.ok(verified.evidence?.proofKey, 'Expected verify() to capture visual PNG proof');
  assert.ok(verified.evidence?.capturedAt && !Number.isNaN(Date.parse(verified.evidence.capturedAt)));
  const verifiedPng = await proofStore.readPng(verified.evidence.proofKey);
  assert.ok(verifiedPng);
  assert.deepEqual(Array.from(verifiedPng.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(verifiedPng.byteLength > 500);
});

test('DUTIC UNSA Moodle 4.x compatibility: captures full course name, .activity-dates, ignores teacher introattachment, and delivers Practica06.pdf', async (t) => {
  assert.ok(process.env.DATABASE_URL, 'Run in Docker with isolated PostgreSQL.');
  const url = new URL(process.env.DATABASE_URL);
  const database = 'browser_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url.href });
  await admin.query('create database ' + database);
  url.pathname = '/' + database;
  const pool = new Pool({ connectionString: url.href });
  await migrate(drizzle(pool), { migrationsFolder: 'src/adapters/persistence/migrations' });
  const root = await mkdtemp(join(tmpdir(), 'personal-browser-dutic-'));

  let uploadedName = '';
  let confirmPending = false;
  let submitted = false;
  const proofs = new Map<string, Uint8Array>();
  let proofCounter = 0;
  const proofStore: ProofStore = {
    async writePng(content: Uint8Array) {
      const key = `dutic-proof-${++proofCounter}.png`;
      proofs.set(key, Uint8Array.from(content));
      return key;
    },
    async readPng(storageKey: string) {
      return proofs.get(storageKey) ?? null;
    },
    async discard(storageKey: string) {
      proofs.delete(storageKey);
    },
  };

  const launch = async (profile: string, headless: boolean): Promise<BrowserContext> => {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      chromiumSandbox: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    });
    if (!headless) await context.addCookies([{ name: 'MoodleSession', value: 'synthetic-session', url: portal }]);
    await context.route('**/*', async (route) => {
      const request = route.request();
      const u = new URL(request.url());
      if (u.origin !== new URL(portal).origin) return route.abort();
      if (!(await request.headerValue('cookie'))?.includes('MoodleSession=synthetic-session')) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<form id="login"><input name="username"></form>' });
      }
      let body = '';
      if (u.pathname.endsWith('/user/profile.php')) {
        body = `<div class="userprofile"><dl><dt>Dirección de correo</dt><dd><a href="mailto:${email}">${email}</a></dd></dl></div>`;
      } else if (u.pathname.endsWith('/course/view.php') && u.searchParams.get('id') === '20') {
        body = `
          <header id="page-header"><div class="page-header-headings"><h1>26B SISTEMAS: METODOS NUMERICOS GB</h1></div></header>
          <main id="region-main">
            <a href="${portal}mod/assign/view.php?id=354676">Práctica 06 - Interpolación</a>
            <a href="${portal}mod/assign/view.php?id=354678">Práctica cerrada</a>
            <a href="${portal}mod/assign/view.php?id=354679">Práctica ya enviada</a>
            <a href="${portal}mod/assign/view.php?id=354680">Práctica retrasada abierta</a>
            <a href="${portal}mod/assign/view.php?id=354681">Práctica vencida sin botón</a>
          </main>`;
      } else if (u.pathname.endsWith('/mod/assign/view.php')) {
        const id = u.searchParams.get('id');
        const action = u.searchParams.get('action');
        if (id === '354676') {
          if (request.method() === 'POST') {
            const raw = request.postData() ?? '';
            if (action === 'savesubmission') {
              const params = new URLSearchParams(raw);
              uploadedName = params.get('uploaded_filename') ?? '';
              return route.fulfill({
                status: 303,
                headers: { location: `${portal}mod/assign/view.php?id=354676` },
                contentType: 'text/html; charset=utf-8',
                body: '',
              });
            }
            if (action === 'submit') {
              confirmPending = true;
              return route.fulfill({
                contentType: 'text/html; charset=utf-8',
                body: `<body class="loggedin"><div class="usermenu"><a href="${portal}user/profile.php">Perfil</a></div><div id="region-main"><h1>Confirmar entrega</h1><form method="post" action="?id=354676&action=confirm"><button type="submit">Confirmar</button></form></div></body>`,
              });
            }
            if (action === 'confirm' && confirmPending) {
              submitted = true;
              confirmPending = false;
              return route.fulfill({
                status: 303,
                headers: { location: `${portal}mod/assign/view.php?id=354676` },
                contentType: 'text/html; charset=utf-8',
                body: '',
              });
            }
          }
          if (action === 'editsubmission') {
            body = `
              <div id="region-main">
                <h1>Práctica 06 - Interpolación</h1>
                <div class="hidden-modal" style="display:none">
                  <div class="fp-upload-form">
                    <input type="file" name="decoy_file">
                  </div>
                </div>
                <form method="post" action="?id=354676&action=savesubmission">
                  <div class="filemanager fm-loading">
                    <div class="fp-btn-add"><a href="#" role="button" id="open-picker">Agregar...</a></div>
                    <div class="fp-content"></div>
                  </div>
                  <input type="hidden" name="uploaded_filename" id="uploaded-filename" value="">
                  <button type="submit" name="submitbutton">Guardar cambios</button>
                </form>
                <div id="filepicker-dialog" style="display:none">
                  <div class="fp-repo-area">
                    <div class="fp-repo"><a href="#">Archivos recientes</a></div>
                    <div class="fp-repo" id="repo-upload"><a href="#">Subir un archivo</a></div>
                  </div>
                  <div class="fp-upload-form" id="active-upload-form" style="display:none">
                    <input type="file" name="repo_upload_file" id="picker-file">
                    <input type="text" name="title" id="picker-title">
                    <button type="button" class="fp-upload-btn" id="picker-upload-btn">Subir este archivo</button>
                  </div>
                </div>
                <script>
                  setTimeout(() => {
                    document.querySelector('.filemanager').classList.remove('fm-loading');
                  }, 40);
                  document.getElementById('open-picker').addEventListener('click', (e) => {
                    e.preventDefault();
                    const dlg = document.getElementById('filepicker-dialog');
                    dlg.classList.add('moodle-dialogue-focused');
                    dlg.style.display = 'block';
                  });
                  document.getElementById('repo-upload').addEventListener('click', (e) => {
                    e.preventDefault();
                    document.getElementById('active-upload-form').style.display = 'block';
                  });
                  document.getElementById('picker-upload-btn').addEventListener('click', () => {
                    const fileInput = document.getElementById('picker-file');
                    const titleInput = document.getElementById('picker-title');
                    const name = titleInput.value || (fileInput.files && fileInput.files[0] ? fileInput.files[0].name : '');
                    if (!name) return;
                    document.getElementById('uploaded-filename').value = name;
                    const item = document.createElement('div');
                    item.className = 'fp-file';
                    item.textContent = name;
                    document.querySelector('.filemanager .fp-content').appendChild(item);
                    const dlg = document.getElementById('filepicker-dialog');
                    dlg.style.display = 'none';
                    dlg.classList.remove('moodle-dialogue-focused');
                  });
                </script>
              </div>`;
          } else {
            const statusText = submitted
              ? 'Enviado para calificar'
              : uploadedName
                ? 'Borrador (no enviado)'
                : 'Todavía no se han realizado envíos';
            const studentFilesCell = uploadedName
              ? `<div class="fileuploadsubmission">
                   <a href="${portal}pluginfile.php/999/assignsubmission_file/submission_files/1/${uploadedName}"><img alt="pdf"></a>
                   <a href="${portal}pluginfile.php/999/assignsubmission_file/submission_files/1/${uploadedName}">${uploadedName}</a>
                   <a href="${portal}pluginfile.php/999/assignsubmission_file/submission_files/1/${uploadedName}">${uploadedName}</a>
                 </div>`
              : '';
            body = `
              <nav aria-label="Ruta de navegación" class="breadcrumb">
                <a href="${portal}course/view.php?id=20" title="26B SISTEMAS: METODOS NUMERICOS GB">26B_20-1703244B</a>
              </nav>
              <div id="region-main">
                <div class="page-header-headings"><h1>Práctica 06 - Interpolación</h1></div>
                <div data-region="activity-dates" class="activity-dates">
                  <div class="description-inner">
                    <div><strong>Apertura:</strong> lunes, 1 de diciembre de 2099, 00:00</div>
                    <div><strong>Cierre:</strong> domingo, 6 de diciembre de 2099, 23:59</div>
                  </div>
                </div>
                <div id="intro" class="activity-description">
                  <p>Resuelva los ejercicios de la guía adjunta.</p>
                  <div class="fileuploadsubmission">
                    <a href="${portal}pluginfile.php/123/mod_assign/introattachment/0/practica07MN2026Bver1.pdf">practica07MN2026Bver1.pdf</a>
                  </div>
                </div>
                <div class="submissionstatustable">
                  <table>
                    <tr><th>Estado de la entrega</th><td>${statusText}</td></tr>
                    <tr><th>Envíos de archivo</th><td>${studentFilesCell}</td></tr>
                  </table>
                </div>
                <a href="?id=354676&action=editsubmission">Agregar entrega</a>
                <form method="post" action="?id=354676&action=submit"><button type="submit">Enviar envío</button></form>
              </div>`;
          }
        } else if (id === '354677') {
          body = `
            <nav aria-label="Ruta de navegación" class="breadcrumb">
              <a href="${portal}course/view.php?id=99" title="26B SISTEMAS: INGENIERIA DE SOFTWARE">26B_99-1703999A</a>
            </nav>
            <div id="region-main">
              <h1>Laboratorio 04</h1>
              <div class="activity-dates">
                <div><strong>Vencimiento:</strong> 10 dic 2099, 11:59 p. m.</div>
              </div>
              <div class="submissionstatustable">
                <table>
                  <tr><th>Estado de la entrega</th><td>Sin intento</td></tr>
                </table>
              </div>
            </div>`;
        } else if (id === '354678') {
          body = `
            <nav class="breadcrumb"><a href="${portal}course/view.php?id=20" title="26B SISTEMAS: METODOS NUMERICOS GB">26B_20-1703244B</a></nav>
            <div id="region-main">
              <h1>Práctica cerrada</h1>
              <div class="submissionstatustable"><table><tr><th>Estado de la entrega</th><td>No se aceptan entregas</td></tr></table></div>
            </div>`;
        } else if (id === '354679') {
          body = `
            <nav class="breadcrumb"><a href="${portal}course/view.php?id=20" title="26B SISTEMAS: METODOS NUMERICOS GB">26B_20-1703244B</a></nav>
            <div id="region-main">
              <h1>Práctica ya enviada</h1>
              <div class="submissionstatustable"><table><tr><th>Estado de la entrega</th><td>Enviado para calificación</td></tr></table></div>
            </div>`;
        } else if (id === '354680') {
          body = `
            <nav class="breadcrumb"><a href="${portal}course/view.php?id=20" title="26B SISTEMAS: METODOS NUMERICOS GB">26B_20-1703244B</a></nav>
            <div id="region-main">
              <h1>Práctica retrasada abierta</h1>
              <div class="activity-dates">
                <div><strong>Apertura:</strong> domingo, 8 de noviembre de 2020, 00:00</div>
                <div><strong>Cierre:</strong> martes, 10 de noviembre de 2020, 23:59</div>
              </div>
              <div class="submissionstatustable"><table><tr><th>Estado de la entrega</th><td>Todavía no se han realizado envíos</td></tr></table></div>
              <button type="submit">Agregar entrega</button>
            </div>`;
        } else if (id === '354681') {
          body = `
            <nav class="breadcrumb"><a href="${portal}course/view.php?id=20" title="26B SISTEMAS: METODOS NUMERICOS GB">26B_20-1703244B</a></nav>
            <div id="region-main">
              <h1>Práctica vencida sin botón</h1>
              <div class="activity-dates">
                <div><strong>Cierre:</strong> martes, 10 de noviembre de 2020, 23:59</div>
              </div>
              <div class="submissionstatustable"><table><tr><th>Estado de la entrega</th><td>Todavía no se han realizado envíos</td></tr></table></div>
            </div>`;
        }
      } else {
        body = `
          <a href="${portal}course/view.php?id=20">26B_20-1703244B</a>
          <a href="${portal}mod/assign/view.php?id=354677">Laboratorio 04</a>`;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<body class="loggedin"><div class="usermenu"><a href="${portal}user/profile.php">Perfil</a></div>${body}</body>`,
      });
    });
    return context;
  };

  const browser = new PersonalBrowser(pool, {
    portalUrl: portal,
    profileDir: join(root, 'profiles'),
    accountNamespace: 'personal-dutic',
    initialAccountId: 'initial',
    viewer: { async start() {}, async stop() {} },
    proofStore,
  }, { launch, loginTimeoutMs: 15000, loginPollMs: 20 });

  t.after(async () => {
    await browser.close();
    await pool.end();
    await admin.query('drop database ' + database);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });

  await browser.initialize();
  await browser.connect(email);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'connected');
  const accountId = browser.current();

  // 1. Capture verifies full course name (both course page heading & breadcrumb title fallback),
  //    .activity-dates deadline parsing, open status variants, and exclusion of closed/submitted.
  const capture = await browser.fetch({ jobId: 'dutic-capture', accountId });
  assert.equal(capture.kind, 'success');
  if (capture.kind !== 'success') return;
  const byId = new Map(capture.assignments.map((item) => [item.externalId, item]));
  assert.equal(byId.size, 3, 'Expected future and open-late Moodle 4.x assignments to be captured, excluding closed/expired');

  const mnTask = byId.get('354676');
  assert.ok(mnTask, 'Expected assignment 354676 to be captured');
  assert.equal(mnTask.course, '26B SISTEMAS: METODOS NUMERICOS GB');
  assert.notEqual(mnTask.course, '26B_20-1703244B');
  assert.equal(mnTask.deadline, '2099-12-07T04:59:00.000Z');

  const swTask = byId.get('354677');
  assert.ok(swTask, 'Expected assignment 354677 to be captured');
  assert.equal(swTask.course, '26B SISTEMAS: INGENIERIA DE SOFTWARE');
  assert.equal(swTask.deadline, '2099-12-11T04:59:00.000Z');

  // Past-due assignment with "Agregar entrega" stays deliverable (deadline null) with full course name.
  const openLateTask = byId.get('354680');
  assert.ok(openLateTask, 'Expected past-due open-late assignment 354680 to be captured');
  assert.equal(openLateTask.course, '26B SISTEMAS: METODOS NUMERICOS GB');
  assert.equal(openLateTask.deadline, null);

  // Past-due assignment without any submission button is excluded as expired.
  assert.equal(byId.has('354681'), false, 'Expected past-due buttonless assignment 354681 to be filtered out');

  // 2. Submit Practica06.pdf: must NOT abort on "Todavía no se han realizado envíos"
  //    or teacher guide practica07MN2026Bver1.pdf in #intro.
  const pdfPath = join(root, 'practica06-stored.pdf');
  const pdfBytes = Buffer.from('%PDF-1.4 practica 06 dutic unsa');
  await writeFile(pdfPath, pdfBytes, { mode: 0o600 });
  const delivery = await browser.submit({
    accountId,
    jobId: 'dutic-delivery-354676',
    externalId: '354676',
    activityUrl: portal + 'mod/assign/view.php?id=354676',
    pdfId: 'pdf-354676',
    localFilePath: pdfPath,
    originalName: 'Practica06.pdf',
    sha256: createHash('sha256').update(pdfBytes).digest('hex'),
  });
  assert.equal(delivery.state, 'confirmed');
  assert.equal(uploadedName, 'Practica06.pdf');
  assert.equal(submitted, true);
  assert.equal(delivery.evidence.visibleStatus, 'Enviado para calificar');
  assert.equal(delivery.evidence.fileName, 'Practica06.pdf');
  assert.ok(delivery.evidence.proofKey, 'Expected confirmed DUTIC delivery to include a PNG proofKey');
  const pngBytes = await proofStore.readPng(delivery.evidence.proofKey);
  assert.ok(pngBytes, 'Expected ProofStore to contain the DUTIC PNG proof');
  assert.deepEqual(
    Array.from(pngBytes.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'Expected DUTIC proof to be a real PNG',
  );
  assert.ok(pngBytes.byteLength > 500);
});

test('Moodle 4.x long filename with truncated .fp-file label and .filemanager.fp-select decoy confirms cleanly', async (t) => {
  assert.ok(process.env.DATABASE_URL, 'Run in Docker with isolated PostgreSQL.');
  const url = new URL(process.env.DATABASE_URL);
  const database = 'browser_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url.href });
  await admin.query('create database ' + database);
  url.pathname = '/' + database;
  const pool = new Pool({ connectionString: url.href });
  await migrate(drizzle(pool), { migrationsFolder: 'src/adapters/persistence/migrations' });
  const root = await mkdtemp(join(tmpdir(), 'personal-browser-longname-'));

  const longFileName = 'Guia_Lab10_Sistemas_Agenticos_2026B_v2.pdf';
  let uploadedName = '';
  let submitted = false;
  const proofs = new Map<string, Uint8Array>();
  let proofCounter = 0;
  const proofStore: ProofStore = {
    async writePng(content: Uint8Array) {
      const key = `longname-proof-${++proofCounter}.png`;
      proofs.set(key, Uint8Array.from(content));
      return key;
    },
    async readPng(storageKey: string) {
      return proofs.get(storageKey) ?? null;
    },
    async discard(storageKey: string) {
      proofs.delete(storageKey);
    },
  };

  const launch = async (profile: string, headless: boolean): Promise<BrowserContext> => {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      chromiumSandbox: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    });
    if (!headless) await context.addCookies([{ name: 'MoodleSession', value: 'synthetic-session', url: portal }]);
    await context.route('**/*', async (route) => {
      const request = route.request();
      const u = new URL(request.url());
      if (u.origin !== new URL(portal).origin) return route.abort();
      if (!(await request.headerValue('cookie'))?.includes('MoodleSession=synthetic-session')) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<form id="login"><input name="username"></form>' });
      }
      let body = '';
      if (u.pathname.endsWith('/user/profile.php')) {
        body = `<div class="userprofile"><dl><dt>Dirección de correo</dt><dd><a href="mailto:${email}">${email}</a></dd></dl></div>`;
      } else if (u.pathname.endsWith('/mod/assign/view.php') && u.searchParams.get('id') === '354663') {
        const action = u.searchParams.get('action');
        if (request.method() === 'POST') {
          const raw = request.postData() ?? '';
          if (action === 'savesubmission') {
            const params = new URLSearchParams(raw);
            uploadedName = params.get('uploaded_filename') ?? '';
            submitted = true;
            return route.fulfill({
              status: 303,
              headers: { location: `${portal}mod/assign/view.php?id=354663` },
              contentType: 'text/html; charset=utf-8',
              body: '',
            });
          }
        }
        if (action === 'editsubmission') {
          body = `
            <div id="region-main">
              <h1>Práctica 04 - Agentes</h1>
              <!-- Hidden Moodle 4.x fp-select template decoy with .fp-btn-add and .fp-file -->
              <div class="filemanager fp-select" style="display:none">
                <div class="fp-btn-add"><a href="#">Decoy add</a></div>
                <div class="fp-file"><span class="fp-filename">template-decoy.pdf</span></div>
              </div>
              <form method="post" action="?id=354663&action=savesubmission">
                <div class="filemanager w-100 fm-loading" id="real-filemanager">
                  <div class="fp-btn-add"><a href="#" role="button" id="open-picker">Agregar...</a></div>
                  <div class="fp-content"></div>
                </div>
                <input type="hidden" name="uploaded_filename" id="uploaded-filename" value="">
                <button type="submit" name="submitbutton">Guardar cambios</button>
              </form>
              <div id="filepicker-dialog" style="display:none">
                <div class="fp-repo-area">
                  <div class="fp-repo" id="repo-upload"><a href="#">Subir un archivo</a></div>
                </div>
                <div class="fp-upload-form" id="active-upload-form" style="display:none">
                  <input type="file" name="repo_upload_file" id="picker-file">
                  <input type="text" name="title" id="picker-title">
                  <button type="button" class="fp-upload-btn" id="picker-upload-btn">Subir este archivo</button>
                </div>
              </div>
              <script>
                setTimeout(() => {
                  const fm = document.getElementById('real-filemanager');
                  fm.classList.remove('fm-loading');
                  fm.classList.add('fm-loaded');
                }, 30);
                document.getElementById('open-picker').addEventListener('click', (e) => {
                  e.preventDefault();
                  const dlg = document.getElementById('filepicker-dialog');
                  dlg.classList.add('moodle-dialogue-focused');
                  dlg.style.display = 'block';
                });
                document.getElementById('repo-upload').addEventListener('click', (e) => {
                  e.preventDefault();
                  document.getElementById('active-upload-form').style.display = 'block';
                });
                document.getElementById('picker-upload-btn').addEventListener('click', () => {
                  const fileInput = document.getElementById('picker-file');
                  const titleInput = document.getElementById('picker-title');
                  const fullName = titleInput.value || (fileInput.files && fileInput.files[0] ? fileInput.files[0].name : '');
                  if (!fullName) return;
                  document.getElementById('uploaded-filename').value = fullName;
                  const item = document.createElement('div');
                  item.className = 'fp-file';
                  // Moodle icon view truncates long filenames visually.
                  item.innerHTML = '<span class="fp-filename">Guia_Lab10_Sistemas_Age...</span>';
                  document.querySelector('#real-filemanager .fp-content').appendChild(item);
                  const dlg = document.getElementById('filepicker-dialog');
                  dlg.style.display = 'none';
                  dlg.classList.remove('moodle-dialogue-focused');
                });
              </script>
            </div>`;
        } else {
          const statusText = submitted ? 'Enviado para calificar' : 'Todavía no se han realizado envíos';
          const fileCell = uploadedName
            ? `<div class="fileuploadsubmission"><a href="${portal}pluginfile.php/354663/assignsubmission_file/submission_files/1/${uploadedName}?forcedownload=1">${uploadedName}</a></div>`
            : '';
          body = `
            <div id="region-main">
              <h1>Práctica 04 - Agentes</h1>
              <div class="submissionstatustable">
                <table>
                  <tr><th>Estado de la entrega</th><td>${statusText}</td></tr>
                  <tr><th>Archivos enviados</th><td>${fileCell}</td></tr>
                </table>
              </div>
              <a href="?id=354663&action=editsubmission">Agregar entrega</a>
            </div>`;
        }
      } else {
        body = `<a href="${portal}mod/assign/view.php?id=354663">Práctica 04 - Agentes</a>`;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<body class="loggedin"><div class="usermenu"><a href="${portal}user/profile.php">Perfil</a></div>${body}</body>`,
      });
    });
    return context;
  };

  const browser = new PersonalBrowser(pool, {
    portalUrl: portal,
    profileDir: join(root, 'profiles'),
    accountNamespace: 'personal-longname',
    initialAccountId: 'initial',
    viewer: { async start() {}, async stop() {} },
    proofStore,
  }, { launch, loginTimeoutMs: 15000, loginPollMs: 20 });

  t.after(async () => {
    await browser.close();
    await pool.end();
    await admin.query('drop database ' + database);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });

  await browser.initialize();
  await browser.connect(email);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'connected');

  const pdfPath = join(root, 'longname-stored.pdf');
  const pdfBytes = Buffer.from('%PDF-1.4 long filename dutic test');
  await writeFile(pdfPath, pdfBytes, { mode: 0o600 });

  const delivery = await browser.submit({
    accountId: browser.current(),
    jobId: 'dutic-longname-354663',
    externalId: '354663',
    activityUrl: portal + 'mod/assign/view.php?id=354663',
    pdfId: 'pdf-354663',
    localFilePath: pdfPath,
    originalName: longFileName,
    sha256: createHash('sha256').update(pdfBytes).digest('hex'),
  });

  assert.equal(delivery.state, 'confirmed');
  assert.equal(uploadedName, longFileName);
  assert.equal(delivery.evidence.visibleStatus, 'Enviado para calificar');
  assert.equal(delivery.evidence.fileName, longFileName);
  assert.ok(delivery.evidence.proofKey, 'Expected confirmed long-filename delivery to include a PNG proofKey');
});

test('browser.verify returns failed on empty DUTIC status and confirmed with real SHA-256 verification on pluginfile.php', async (t) => {
  assert.ok(process.env.DATABASE_URL, 'Run in Docker with isolated PostgreSQL.');
  const url = new URL(process.env.DATABASE_URL);
  const database = 'browser_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url.href });
  await admin.query('create database ' + database);
  url.pathname = '/' + database;
  const pool = new Pool({ connectionString: url.href });
  await migrate(drizzle(pool), { migrationsFolder: 'src/adapters/persistence/migrations' });
  const root = await mkdtemp(join(tmpdir(), 'personal-browser-verify-sha-'));

  const fileName = 'Guia_Lab10_Sistemas_Agenticos_2026B_v2.pdf';
  const exactBytes = Buffer.from('%PDF-1.4 exact submitted bytes for real sha256 verification\n%%EOF\n');
  const wrongBytes = Buffer.from('%PDF-1.4 tampered or different file bytes\n%%EOF\n');
  let mode: 'empty' | 'submitted-wrong-bytes' | 'submitted-exact-bytes' | 'submitted-redirect-logout' = 'empty';
  let pluginfileHits = 0;
  let logoutHits = 0;

  const proofs = new Map<string, Uint8Array>();
  let proofCounter = 0;
  const proofStore: ProofStore = {
    async writePng(content: Uint8Array) {
      const key = `verify-sha-proof-${++proofCounter}.png`;
      proofs.set(key, Uint8Array.from(content));
      return key;
    },
    async readPng(storageKey: string) {
      return proofs.get(storageKey) ?? null;
    },
    async discard(storageKey: string) {
      proofs.delete(storageKey);
    },
  };

  const launch = async (profile: string, headless: boolean): Promise<BrowserContext> => {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      chromiumSandbox: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    });
    if (!headless) await context.addCookies([{ name: 'MoodleSession', value: 'synthetic-session', url: portal }]);
    await context.route('**/*', async (route) => {
      const request = route.request();
      const u = new URL(request.url());
      if (u.origin !== new URL(portal).origin) return route.abort();
      if (!(await request.headerValue('cookie'))?.includes('MoodleSession=synthetic-session')) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<form id="login"><input name="username"></form>' });
      }
      if (u.pathname.endsWith('/login/logout.php')) {
        logoutHits += 1;
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<p>logged out</p>' });
      }
      if (u.pathname.includes('/pluginfile.php/') && !u.pathname.includes('/introattachment/')) {
        pluginfileHits += 1;
        if (mode === 'submitted-redirect-logout') {
          return route.fulfill({
            status: 302,
            headers: { location: `${portal}login/logout.php` },
            body: '',
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/pdf',
          headers: { 'content-disposition': `attachment; filename="${fileName}"` },
          body: mode === 'submitted-exact-bytes' ? exactBytes : wrongBytes,
        });
      }
      let body = '';
      if (u.pathname.endsWith('/user/profile.php')) {
        body = `<div class="userprofile"><dl><dt>Dirección de correo</dt><dd><a href="mailto:${email}">${email}</a></dd></dl></div>`;
      } else if (u.pathname.endsWith('/mod/assign/view.php') && u.searchParams.get('id') === '354664') {
        const isEmpty = mode === 'empty';
        const statusText = isEmpty ? 'Todavía no se han realizado envíos' : 'Enviado para calificar';
        const fileCell = isEmpty
          ? ''
          : `<div class="fileuploadsubmission"><a href="${portal}pluginfile.php/354664/assignsubmission_file/submission_files/9/${fileName}?forcedownload=1">${fileName}</a></div>`;
        body = `
          <div id="region-main">
            <h1>Práctica 04 - Verificación</h1>
            <div id="intro"><a href="${portal}pluginfile.php/354664/mod_assign/introattachment/0/guia.pdf">guia.pdf</a></div>
            <div class="submissionstatustable">
              <table>
                <tr><th>Estado de la entrega</th><td>${statusText}</td></tr>
                <tr><th>Archivos enviados</th><td>${fileCell}</td></tr>
              </table>
            </div>
          </div>`;
      } else {
        body = `<a href="${portal}mod/assign/view.php?id=354664">Práctica 04 - Verificación</a>`;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<body class="loggedin"><div class="usermenu"><a href="${portal}user/profile.php">Perfil</a></div>${body}</body>`,
      });
    });
    return context;
  };

  const browser = new PersonalBrowser(pool, {
    portalUrl: portal,
    profileDir: join(root, 'profiles'),
    accountNamespace: 'personal-verify-sha',
    initialAccountId: 'initial',
    viewer: { async start() {}, async stop() {} },
    proofStore,
  }, { launch, loginTimeoutMs: 15000, loginPollMs: 20 });

  t.after(async () => {
    await browser.close();
    await pool.end();
    await admin.query('drop database ' + database);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });

  await browser.initialize();
  await browser.connect(email);
  for (let n = 0; n < 500 && (await browser.status()).state === 'connecting'; n++) await sleep(20);
  assert.equal((await browser.status()).state, 'connected');

  const pdfPath = join(root, 'verify-sha.pdf');
  await writeFile(pdfPath, exactBytes, { mode: 0o600 });
  const order = {
    accountId: browser.current(),
    jobId: 'dutic-verify-354664',
    externalId: '354664',
    activityUrl: portal + 'mod/assign/view.php?id=354664',
    pdfId: 'pdf-354664',
    localFilePath: pdfPath,
    originalName: fileName,
    sha256: createHash('sha256').update(exactBytes).digest('hex'),
  };

  // 1. Empty DUTIC assignment returns definitive failed (with evidence + PNG proof), never stuck in needs_verification.
  mode = 'empty';
  const emptyResult = await browser.verify(order);
  assert.equal(emptyResult.state, 'failed');
  assert.equal(emptyResult.evidence?.visibleStatus, 'Todavía no se han realizado envíos');
  assert.equal(emptyResult.evidence?.fileName, undefined);
  assert.ok(emptyResult.evidence?.proofKey, 'Expected PNG proof on empty DUTIC verification');
  assert.equal(pluginfileHits, 0);

  // 2. Submitted assignment with mismatched bytes at pluginfile.php stays needs_verification.
  mode = 'submitted-wrong-bytes';
  const mismatchResult = await browser.verify(order);
  assert.equal(mismatchResult.state, 'needs_verification');
  assert.equal(pluginfileHits, 1);

  // 3. Submitted assignment whose pluginfile.php returns 302 to logout.php MUST NOT follow redirects!
  mode = 'submitted-redirect-logout';
  const redirectResult = await browser.verify(order);
  assert.equal(redirectResult.state, 'needs_verification');
  assert.equal(logoutHits, 0, 'Read-only verification fetch must never follow HTTP redirects');
  assert.equal(pluginfileHits, 2);

  // 4. Submitted assignment serving exact PDF bytes at pluginfile.php confirms with real SHA-256 verification.
  mode = 'submitted-exact-bytes';
  const confirmedResult = await browser.verify(order);
  assert.equal(confirmedResult.state, 'confirmed');
  assert.equal(confirmedResult.evidence.visibleStatus, 'Enviado para calificar');
  assert.equal(confirmedResult.evidence.fileName, fileName);
  assert.ok(confirmedResult.evidence.proofKey, 'Expected PNG proof on SHA-256 confirmed verification');
  assert.equal(pluginfileHits, 3);
});
