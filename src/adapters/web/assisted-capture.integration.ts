import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createApplication } from '../../bootstrap/application';
import { CargarPdf } from '../../core/application/tasks';
import { LocalPdfStore } from '../persistence/files';
import { postgresDatabase, PostgresTaskRepository } from '../persistence/repositories';

const portalUrl = 'https://aula.example.invalid/ensayo/';
const portalAccount = 'estudiante-ensayo';
const accountId = 'capture-test';

async function cli(databaseUrl: string, uploadDir: string, capture: unknown) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, ['dist/bootstrap/import-aula.js'], {
      env: {
        ...process.env, DATABASE_URL: databaseUrl, UPLOAD_DIR: uploadDir, NODE_ENV: 'development',
        AULA_CAPTURE_MODE: 'assisted', AULA_PORTAL_URL: portalUrl, AULA_PORTAL_ACCOUNT: portalAccount,
        AULA_ACCOUNT_ID: accountId, DEMO_MODE: 'false',
      },
      timeout: 5000,
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
    child.stdin?.end(JSON.stringify(capture));
  });
}

async function events(origin: string) {
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
          if (read.done) assert.fail('El stream se cerró antes de emitir la revisión.');
          buffer = (buffer + decoder.decode(read.value, { stream: true })).replaceAll('\r\n', '\n');
        }
      }
    },
    close() { controller.abort(); },
  };
}

test('el comando actualiza el MVC por SSE y recupera cambios al reconectar', async (suite) => {
  assert.ok(process.env.DATABASE_URL, 'Ejecuta test:integration dentro de Docker Compose.');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  suite.after(() => admin.end());
  const database = 'fetcher_test_' + randomUUID().replaceAll('-', '');
  await admin.query('create database ' + database);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + database;
  const databaseUrl = url.toString();
  const pool = new Pool({ connectionString: databaseUrl });
  const directory = await mkdtemp(join(tmpdir(), 'aula-capture-'));
  suite.after(async () => {
    await pool.end();
    const cleanup = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await cleanup.query('drop database ' + database);
    } finally {
      await cleanup.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
  await migrate(postgresDatabase(pool), { migrationsFolder: 'src/adapters/persistence/migrations' });

  const app = await createApplication({
    databaseUrl, uploadDir: directory, accountId, demoMode: false, host: '127.0.0.1', port: 0,
    assistedCapture: { portalUrl, portalAccount },
  }, false);
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const read = async () => (await fetch(origin)).text();
  let subscriber: Awaited<ReturnType<typeof events>> | undefined;

  const assignment = {
    externalId: '42', title: 'Actividad de ensayo', course: 'Curso ficticio',
    activityUrl: portalUrl + 'mod/assign/view.php?id=42', deadline: null, destination: 'aula_virtual',
  };
  const capture = { kind: 'success', observedAccountId: portalAccount, assignments: [assignment] };
  const importSuccess = async (payload: unknown) => {
    const result = await cli(databaseUrl, directory, payload);
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout) as { jobId: string; updatedTasks: number };
    assert.equal(receipt.updatedTasks, 1);
    return receipt.jobId;
  };

  try {
    assert.match(await read(), /data-capture-revision=""/);
    assert.match(await read(), /chat de Codex/);
    assert.doesNotMatch(await read(), /action="\/busquedas"/);
    assert.equal((await fetch(origin + '/busquedas', { method: 'POST' })).status, 409);

    subscriber = await events(origin);
    assert.equal(await subscriber.nextRevision(), null);
    const firstRevision = await importSuccess({
      ...capture, assignments: [
        assignment,
        { ...assignment, externalId: '43', title: 'Vencida', deadline: '2020-01-01' },
      ],
    });
    assert.equal(await subscriber.nextRevision(), firstRevision);
    assert.match(await read(), /Sin fecha[\s\S]*Actividad de ensayo/);

    const tasks = new PostgresTaskRepository(postgresDatabase(pool));
    const [initialTask] = await tasks.list(accountId);
    assert.ok(initialTask);
    const pdf = await new CargarPdf(tasks, new LocalPdfStore(directory)).execute({
      accountId, taskId: initialTask.taskId, originalName: 'ensayo.pdf', content: Buffer.from('%PDF-1.4\n%%EOF\n'),
    });
    const repeated = await importSuccess(capture);
    assert.equal(await subscriber.nextRevision(), repeated);
    assert.equal((await read()).match(/Actividad de ensayo/g)?.length, 1);
    assert.equal((await tasks.find(accountId, initialTask.taskId))?.currentPdf?.pdfId, pdf.pdfId);
    subscriber.close();
    subscriber = undefined;

    const deadline = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    const changed = { ...assignment, deadline };
    const latest = await importSuccess({ ...capture, assignments: [changed] });
    subscriber = await events(origin);
    assert.equal(await subscriber.nextRevision(), latest);
    const html = await read();
    assert.match(html, new RegExp('data-capture-revision="' + latest + '"'));
    assert.match(html, new RegExp('datetime="' + deadline + '"'));
    assert.doesNotMatch(html, /Vencida/);
    const link = html.match(/href="(\/tareas\/[^"]+)"/)?.[1];
    assert.ok(link);
    assert.doesNotMatch(await (await fetch(origin + link)).text(), /Autorizar y entregar/);

    for (const invalid of [
      { ...capture, observedAccountId: 'otra-cuenta' },
      { ...capture, assignments: [{ ...changed, deadline: 'inválido' }] },
      { ...capture, assignments: [changed, {
        ...changed, activityUrl: 'https://aula.example.invalid/otro-periodo/mod/assign/view.php?id=42',
      }] },
      { kind: 'session_expired' },
    ]) {
      assert.equal((await cli(databaseUrl, directory, invalid)).code, 1);
      assert.match(await read(), new RegExp('data-capture-revision="' + latest + '"'));
    }
    subscriber.close();
    subscriber = undefined;
  } finally {
    subscriber?.close();
    await app.close();
  }
});
