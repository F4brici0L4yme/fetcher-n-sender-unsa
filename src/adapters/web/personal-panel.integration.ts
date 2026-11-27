import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createApplication } from '../../bootstrap/application';
import { postgresDatabase } from '../persistence/repositories';

async function openEvents(origin: string) {
  const controller = new AbortController();
  const response = await fetch(origin + '/eventos/tareas', {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async nextRevision() {
      while (true) {
        const separator = buffer.indexOf('\n\n');
        if (separator >= 0) {
          const record = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const payload = record.split('\n').find((line) => line.startsWith('data:'));
          if (record.includes('event: tasks-version') && payload) {
            return (JSON.parse(payload.slice(5)) as { revision: string | null }).revision;
          }
        } else {
          const read = await reader.read();
          if (read.done) assert.fail('SSE closed before emitting revision.');
          buffer = (buffer + decoder.decode(read.value, { stream: true })).replaceAll('\r\n', '\n');
        }
      }
    },
    close() { controller.abort(); },
  };
}

test('personal panel integrates notes CRUD, session controls, account pinning, and durable SSE revisions', async (suite) => {
  assert.ok(process.env.DATABASE_URL, 'Ejecuta test:integration dentro de Docker Compose.');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  suite.after(() => admin.end());
  const database = 'panel_personal_test_' + randomUUID().replaceAll('-', '');
  await admin.query('create database ' + database);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + database;
  const databaseUrl = url.toString();
  const pool = new Pool({ connectionString: databaseUrl });
  const uploadDir = await mkdtemp(join(tmpdir(), 'panel-personal-uploads-'));
  const profileDir = await mkdtemp(join(tmpdir(), 'panel-personal-profiles-'));
  suite.after(async () => {
    await pool.end();
    const cleanup = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await cleanup.query('drop database ' + database);
    } finally {
      await cleanup.end();
      await rm(uploadDir, { recursive: true, force: true });
      await rm(profileDir, { recursive: true, force: true });
    }
  });
  await migrate(postgresDatabase(pool), { migrationsFolder: 'src/adapters/persistence/migrations' });

  const app = await createApplication({
    databaseUrl,
    uploadDir,
    demoMode: false,
    accountId: 'initial-personal',
    host: '127.0.0.1',
    port: 0,
    personalBrowser: {
      portalUrl: 'https://aula.example.invalid/2099B/',
      profileDir,
      accountNamespace: 'personal',
      portalAccount: undefined,
      display: ':99',
      viewerPort: 6080,
    },
  }, false);

  let subscriber: Awaited<ReturnType<typeof openEvents>> | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();

    const initialHtml = await (await fetch(origin + '/')).text();
    assert.match(initialHtml, /Sesión personal/);
    assert.match(initialHtml, /Conectar sesión/);
    assert.match(initialHtml, /href="\/notas\/nueva"/);
    assert.match(initialHtml, /href="\/sesion"/);
    assert.match(initialHtml, /data-live-revision="initial-personal:0"/);

    // Dedicated /sesion tab renders session controls, live revision, and trust guarantees
    const sessionHtml = await (await fetch(origin + '/sesion')).text();
    assert.match(sessionHtml, /<h1>Sesión DUTIC<\/h1>/);
    assert.match(sessionHtml, /Conectar sesión/);
    assert.match(sessionHtml, /name="returnTo" value="\/sesion"/);
    assert.match(sessionHtml, /data-live-revision="initial-personal:0"/);
    assert.match(sessionHtml, /Perfil aislado por cuenta/);

    // Invalid identity rejected with 400 and accessible error (both on / and /sesion)
    const badConnect = await fetch(origin + '/sesion/conectar', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ accountId: 'initial-personal', identity: 'not-an-email' }),
      redirect: 'manual',
    });
    assert.equal(badConnect.status, 400);
    assert.match(await badConnect.text(), /Ingresa el correo/);

    const badSessionConnect = await fetch(origin + '/sesion/conectar', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ accountId: 'initial-personal', identity: 'not-an-email', returnTo: '/sesion' }),
      redirect: 'manual',
    });
    assert.equal(badSessionConnect.status, 400);
    const badSessionHtml = await badSessionConnect.text();
    assert.match(badSessionHtml, /<h1>Sesión DUTIC<\/h1>/);
    assert.match(badSessionHtml, /Ingresa el correo/);

    // Stale accountId form submission rejected with 409
    const staleSearch = await fetch(origin + '/busquedas', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ accountId: 'wrong-account' }),
      redirect: 'manual',
    });
    assert.equal(staleSearch.status, 409);

    // SSE emits initial durable revision and advances on personal note CRUD
    subscriber = await openEvents(origin);
    assert.equal(await subscriber.nextRevision(), 'initial-personal:0');

    const newNoteForm = await fetch(origin + '/notas/nueva');
    assert.equal(newNoteForm.status, 200);
    assert.match(await newNoteForm.text(), /Nueva nota/);

    const created = await fetch(origin + '/notas', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        accountId: 'initial-personal',
        title: 'Estudiar cálculo',
        description: 'Capítulo 4',
        priority: 'alta',
        deadline: '2026-12-10',
        status: 'pendiente',
      }),
      redirect: 'manual',
    });
    assert.equal(created.status, 303);
    assert.equal(await subscriber.nextRevision(), 'initial-personal:1');

    const afterCreateHtml = await (await fetch(origin + '/')).text();
    assert.match(afterCreateHtml, /Estudiar cálculo/);
    assert.match(afterCreateHtml, /Nota personal · Prioridad Alta/);
    const notesTabHtml = await (await fetch(origin + '/?vista=notas')).text();
    assert.match(notesTabHtml, /<h1>Mis Notas<\/h1>/);
    assert.match(notesTabHtml, /Estudiar cálculo/);
    const tasksTabHtml = await (await fetch(origin + '/?vista=tareas')).text();
    assert.match(tasksTabHtml, /<h1>Tareas DUTIC<\/h1>/);
    assert.doesNotMatch(tasksTabHtml, /Estudiar cálculo/);
    const noteHref = afterCreateHtml.match(/href="(\/notas\/[0-9a-f-]+)"/)?.[1];
    assert.ok(noteHref);
    const inlineCompleteForm = afterCreateHtml.match(
      new RegExp(`action="${noteHref}/completar">[\\s\\S]*?<input type="hidden" name="accountId" value="([^"]*)"`),
    );
    assert.ok(inlineCompleteForm, 'Inline complete form must render on main panel.');
    assert.equal(inlineCompleteForm[1], 'initial-personal');

    const completed = await fetch(origin + noteHref + '/completar', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ accountId: inlineCompleteForm[1]! }),
      redirect: 'manual',
    });
    assert.equal(completed.status, 303);
    assert.equal(await subscriber.nextRevision(), 'initial-personal:2');

    const afterCompleteHtml = await (await fetch(origin + '/')).text();
    assert.match(afterCompleteHtml, /Completadas[\s\S]*Estudiar cálculo/);
    const completedTabHtml = await (await fetch(origin + '/?vista=completadas')).text();
    assert.match(completedTabHtml, /<h1>Completadas<\/h1>/);
    assert.match(completedTabHtml, /Estudiar cálculo/);

    const removed = await fetch(origin + noteHref + '/eliminar', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ accountId: 'initial-personal' }),
      redirect: 'manual',
    });
    assert.equal(removed.status, 303);
    assert.equal(await subscriber.nextRevision(), 'initial-personal:3');
    assert.doesNotMatch(await (await fetch(origin + '/')).text(), /Estudiar cálculo/);
  } finally {
    subscriber?.close();
    await app.close();
  }
});
