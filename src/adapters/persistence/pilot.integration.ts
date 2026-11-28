import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createApplication } from '../../bootstrap/application';
import { AssignmentFetcher, AssignmentSender } from '../../core/application/ports/academic';
import type { ProofStore } from '../../core/application/ports/persistence';
import { BuscarTareas, CargarPdf, DescartarIntentoEntrega, ListarTareas, SolicitarEntrega, VerificarEntrega } from '../../core/application/tasks';
import { AcademicWorker } from '../../core/application/worker';
import { CapturedAssignment, DeliveryOrder } from '../../core/domain/model';
import { LocalPdfStore } from './files';
import {
  postgresDatabase, PostgresAccountRevisionRepository, PostgresJobRepository, PostgresTaskRepository, PostgresWorkerRepository,
} from './repositories';
import { agentDeliveryProposals, deliveries } from './schema';

function samplePdf() {
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>',
  ].entries()) {
    offsets.push(pdf.length);
    pdf += (index + 1) + ' 0 obj\n' + body + '\nendobj\n';
  }
  const xref = pdf.length;
  pdf += 'xref\n0 4\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf);
}

test('integración del piloto con PostgreSQL y PDF en disco', async (suite) => {
  assert.ok(process.env.DATABASE_URL, 'Ejecuta test:integration dentro de Docker Compose.');
  const url = new URL(process.env.DATABASE_URL);
  const database = 'fetcher_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url.toString() });
  suite.after(() => admin.end());
  await admin.query('create database ' + database);
  url.pathname = '/' + database;

  const pool = new Pool({ connectionString: url.toString() });
  const directory = await mkdtemp(join(tmpdir(), 'fetcher-pdf-'));
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
  const db = postgresDatabase(pool);
  await migrate(db, { migrationsFolder: 'src/adapters/persistence/migrations' });
  await migrate(db, { migrationsFolder: 'src/adapters/persistence/migrations' });

  const accountId = 'integration';
  const assignment: CapturedAssignment = {
    externalId: 'act-1', course: 'Curso', title: 'Guía', destination: 'aula_virtual',
    deadline: '2026-11-26', activityUrl: 'https://aula.example.invalid/mod/assign/view.php?id=1',
  };
  const clock = () => new Date('2026-11-25T20:00:00-05:00');
  let candidates: CapturedAssignment[] = [assignment];
  let fetchCount = 0;
  const fetcher: AssignmentFetcher = {
    async fetch() {
      fetchCount++;
      await sleep(40);
      return { kind: 'success', assignments: candidates };
    },
  };
  const submitted: DeliveryOrder[] = [];
  const verified: DeliveryOrder[] = [];
  const sender: AssignmentSender = {
    async submit(order) {
      submitted.push(order);
      return { state: 'confirmed', evidence: {
        activityUrl: order.activityUrl, visibleStatus: 'Enviado', fileName: order.originalName,
      } };
    },
    async verify(order) {
      verified.push(order);
      return { state: 'needs_verification' };
    },
  };

  const tasks = new PostgresTaskRepository(db);
  const jobs = new PostgresJobRepository(db);
  const work = new PostgresWorkerRepository(pool);
  const files = new LocalPdfStore(directory);
  const search = new BuscarTareas(jobs);
  const list = new ListarTareas(tasks, clock);
  const upload = new CargarPdf(tasks, files);
  const deliver = new SolicitarEntrega(jobs);
  const worker = new AcademicWorker(work, fetcher, sender, files, clock);
  let taskId: string;

  await suite.test('solo un worker toma la cuenta, dos sincronizaciones conservan una tarea y la zona', async () => {
    const first = await search.execute(accountId);
    const second = await search.execute(accountId);
    await Promise.all([worker.tick(accountId), worker.tick(accountId)]);
    assert.equal(fetchCount, 1);
    candidates = [{ ...assignment, title: 'Guía corregida' }];
    await worker.tick(accountId);
    const result = await list.execute(accountId);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.title, 'Guía corregida');
    assert.equal(result[0]?.deadline, '2026-11-26');
    taskId = result[0]!.taskId;
    assert.equal((await jobs.find(accountId, first.jobId))?.state, 'completed');
    assert.equal((await jobs.find(accountId, second.jobId))?.state, 'completed');
  });

  await suite.test('la orden guarda el PDF original y la autorización duplicada devuelve el mismo trabajo', async () => {
    const first = await upload.execute({ accountId, taskId, originalName: 'original.pdf', content: samplePdf() });
    const [one, two] = await Promise.all([deliver.execute({ accountId, taskId, pdfId: first.pdfId }),
      deliver.execute({ accountId, taskId, pdfId: first.pdfId })]);
    assert.deepEqual(one, two);
    const next = await upload.execute({ accountId, taskId, originalName: 'nuevo.pdf', content: samplePdf() });
    assert.equal((await tasks.find(accountId, taskId))?.currentPdf?.pdfId, next.pdfId);
    await assert.rejects(deliver.execute({ accountId, taskId, pdfId: next.pdfId }), { code: 'delivery_pending' });
    await assert.rejects(upload.execute({ accountId, taskId, originalName: 'malo.pdf', content: Buffer.from('malo') }),
      { code: 'invalid_pdf' });
    assert.equal((await tasks.find(accountId, taskId))?.currentPdf?.pdfId, next.pdfId);

    const [saved] = await db.select().from(deliveries).where(eq(deliveries.jobId, one.jobId));
    assert.equal(saved?.pdfId, first.pdfId);
    assert.equal(saved?.sha256, first.sha256);
    await worker.tick(accountId);
    assert.equal(submitted[0]?.originalName, 'original.pdf');
    assert.equal((await jobs.find(accountId, one.jobId))?.state, 'confirmed');
    assert.equal(await jobs.find('another-account', one.jobId), null);
  });

  await suite.test('checksum incorrecto, archivos desactualizados y destinos fuera del piloto', async () => {
    const old = (await tasks.find(accountId, taskId))!.currentPdf!;
    const current = await upload.execute({ accountId, taskId, originalName: 'alterado.pdf', content: samplePdf() });
    await assert.rejects(deliver.execute({ accountId, taskId, pdfId: old.pdfId }), { code: 'stale_pdf' });
    const { jobId } = await deliver.execute({ accountId, taskId, pdfId: current.pdfId });
    await writeFile(files.path(current.pdfId.replaceAll('-', '') + '.pdf'), 'alterado');
    await worker.tick(accountId);
    assert.equal((await jobs.find(accountId, jobId))?.state, 'failed');
    assert.equal(submitted.length, 1);

    for (const destination of ['unknown', 'other'] as const) {
      candidates = [{ ...assignment, destination }];
      await search.execute(accountId);
      await worker.tick(accountId);
      const pdf = await upload.execute({ accountId, taskId, originalName: 'informe.pdf', content: samplePdf() });
      await assert.rejects(deliver.execute({ accountId, taskId, pdfId: pdf.pdfId }), { code: 'unsupported_destination' });
    }
  });

  await suite.test('recupera la búsqueda e inspecciona el envío interrumpido sin repetir submit', async () => {
    candidates = [assignment];
    const searchJob = await search.execute(accountId);
    await work.withAccountLock(accountId, async (session) => { assert.equal((await session.claimNext())?.kind, 'search'); });
    await worker.tick(accountId);
    assert.equal((await jobs.find(accountId, searchJob.jobId))?.state, 'completed');

    const current = await upload.execute({ accountId, taskId, originalName: 'reinicio.pdf', content: samplePdf() });
    const { jobId } = await deliver.execute({ accountId, taskId, pdfId: current.pdfId });
    await work.withAccountLock(accountId, async (session) => { assert.equal((await session.claimNext())?.kind, 'delivery'); });
    assert.equal((await jobs.find(accountId, jobId))?.state, 'running');
    const restarted = new AcademicWorker(new PostgresWorkerRepository(pool), fetcher, sender, files, clock);
    await restarted.tick(accountId);
    await restarted.tick(accountId);
    assert.equal(submitted.length, 1);
    assert.equal(verified.length, 1);
    assert.equal(verified[0]?.jobId, jobId);
    assert.equal((await jobs.find(accountId, jobId))?.state, 'needs_verification');
    const next = await upload.execute({ accountId, taskId, originalName: 'distinto.pdf', content: samplePdf() });
    await assert.rejects(deliver.execute({ accountId, taskId, pdfId: next.pdfId }), { code: 'delivery_pending' });
  });

  await suite.test('un nombre de archivo distinto queda por verificar aunque el sender diga confirmado', async () => {
    const otherAccount = 'ambiguous-evidence';
    const ambiguousSender: AssignmentSender = {
      async submit(order) {
        return { state: 'confirmed', evidence: {
          activityUrl: order.activityUrl, visibleStatus: 'Enviado', fileName: 'otro.pdf',
        } };
      },
      async verify() { return { state: 'needs_verification' }; },
    };
    const anotherWorker = new AcademicWorker(work, fetcher, ambiguousSender, files, clock);
    await search.execute(otherAccount);
    await anotherWorker.tick(otherAccount);
    const [task] = await list.execute(otherAccount);
    assert.ok(task);
    const pdf = await upload.execute({
      accountId: otherAccount, taskId: task.taskId, originalName: 'correcto.pdf', content: samplePdf(),
    });
    const { jobId } = await deliver.execute({ accountId: otherAccount, taskId: task.taskId, pdfId: pdf.pdfId });
    await anotherWorker.tick(otherAccount);
    assert.equal((await jobs.find(otherAccount, jobId))?.state, 'needs_verification');
    await anotherWorker.tick(otherAccount);
    assert.equal((await jobs.find(otherAccount, jobId))?.state, 'needs_verification');
  });

  await suite.test('DescartarIntentoEntrega descarta intentos fallidos o por verificar, limpia propuestas/comprobante y permite reintentar con el mismo PDF', async () => {
    const discardAccount = 'discard-account';
    const discardedProofKeys: string[] = [];
    const proofStore: ProofStore = {
      async writePng() { return 'unused.png'; },
      async readPng() { return null; },
      async discard(key) { discardedProofKeys.push(key); },
    };
    const revisions = new PostgresAccountRevisionRepository(db);
    const verify = new VerificarEntrega(jobs);
    const discard = new DescartarIntentoEntrega(jobs, proofStore);

    let submitMode: 'needs_verification' | 'confirmed' = 'needs_verification';
    let verifyMode: 'needs_verification' | 'failed' = 'needs_verification';
    const customSender: AssignmentSender = {
      async submit(order) {
        if (submitMode === 'confirmed') {
          return {
            state: 'confirmed',
            evidence: {
              activityUrl: order.activityUrl,
              visibleStatus: 'Enviado para calificar',
              fileName: order.originalName,
              proofKey: 'confirmed-proof.png',
              capturedAt: '2026-11-26T10:15:00.000Z',
            },
          };
        }
        return {
          state: 'needs_verification',
          evidence: {
            activityUrl: order.activityUrl,
            visibleStatus: 'Todavía no se han realizado envíos',
            proofKey: 'uncertain-proof.png',
            capturedAt: '2026-11-26T10:00:00.000Z',
          },
        };
      },
      async verify(order) {
        if (verifyMode === 'failed') {
          return {
            state: 'failed',
            evidence: {
              activityUrl: order.activityUrl,
              visibleStatus: 'Todavía no se han realizado envíos',
              proofKey: 'empty-dutic-proof.png',
              capturedAt: '2026-11-26T10:05:00.000Z',
            },
          };
        }
        return {
          state: 'needs_verification',
          evidence: {
            activityUrl: order.activityUrl,
            visibleStatus: 'Borrador (no enviado)',
            proofKey: 'still-uncertain-proof.png',
            capturedAt: '2026-11-26T10:02:00.000Z',
          },
        };
      },
    };
    const discardWorker = new AcademicWorker(work, fetcher, customSender, files, clock);

    candidates = [assignment];
    await search.execute(discardAccount);
    await discardWorker.tick(discardAccount);
    const [task] = await list.execute(discardAccount);
    assert.ok(task);

    const pdf = await upload.execute({
      accountId: discardAccount, taskId: task.taskId, originalName: 'Guia_Lab10_Sistemas_Agenticos_2026B_v2.pdf', content: samplePdf(),
    });
    const firstAttempt = await deliver.execute({ accountId: discardAccount, taskId: task.taskId, pdfId: pdf.pdfId });

    // Reject discarding while authorized or running.
    await assert.rejects(
      discard.execute(discardAccount, task.taskId, firstAttempt.jobId),
      { code: 'delivery_active' },
    );
    await work.withAccountLock(discardAccount, async (session) => {
      assert.equal((await session.claimNext())?.kind, 'delivery');
    });
    assert.equal((await jobs.find(discardAccount, firstAttempt.jobId))?.state, 'running');
    await assert.rejects(
      discard.execute(discardAccount, task.taskId, firstAttempt.jobId),
      { code: 'delivery_active' },
    );

    // Recover interrupted delivery -> needs_verification, then verification settles to needs_verification.
    await discardWorker.tick(discardAccount);
    assert.equal((await jobs.find(discardAccount, firstAttempt.jobId))?.state, 'needs_verification');

    // Attach an agent proposal pointing to this delivery job to verify FK cleanup.
    const [proposal] = await db.insert(agentDeliveryProposals).values({
      accountId: discardAccount,
      source: 'panel',
      instruction: 'subir guia lab 10',
      taskId: task.taskId,
      pdfId: pdf.pdfId,
      state: 'authorized',
      deliveryJobId: firstAttempt.jobId,
    }).returning({ id: agentDeliveryProposals.id });
    assert.ok(proposal);

    // Trigger read-only verification returning definitive failed and assert Spanish summary.
    verifyMode = 'failed';
    await verify.execute(discardAccount, firstAttempt.jobId);
    await discardWorker.tick(discardAccount);
    const failedJob = await jobs.find(discardAccount, firstAttempt.jobId);
    assert.equal(failedJob?.state, 'failed');
    assert.equal(failedJob?.summary, 'DUTIC confirmó que todavía no hay ningún envío registrado. Puedes volver a intentar.');

    // Wrong account or missing job/task is rejected with not_found.
    await assert.rejects(discard.execute('other-account', task.taskId, firstAttempt.jobId), { code: 'not_found' });
    await assert.rejects(discard.execute(discardAccount, task.taskId, randomUUID()), { code: 'not_found' });

    const revisionBefore = await revisions.currentRevision(discardAccount);
    const discarded = await discard.execute(discardAccount, task.taskId, firstAttempt.jobId);
    assert.deepEqual(discarded, { jobId: firstAttempt.jobId });
    assert.deepEqual(discardedProofKeys, ['empty-dutic-proof.png']);
    assert.equal(await jobs.find(discardAccount, firstAttempt.jobId), null);
    assert.notEqual(await revisions.currentRevision(discardAccount), revisionBefore);

    // Current PDF is preserved, task has no active delivery, and proposal FK is cleared.
    const reloadedTask = await tasks.find(discardAccount, task.taskId);
    assert.equal(reloadedTask?.currentPdf?.pdfId, pdf.pdfId);
    assert.equal(reloadedTask?.delivery, null);
    const [reloadedProposal] = await db.select().from(agentDeliveryProposals).where(eq(agentDeliveryProposals.id, proposal.id));
    assert.equal(reloadedProposal?.deliveryJobId, null);

    // Immediate re-authorization with the EXACT SAME pdfId creates a new job.
    const secondAttempt = await deliver.execute({ accountId: discardAccount, taskId: task.taskId, pdfId: pdf.pdfId });
    assert.notEqual(secondAttempt.jobId, firstAttempt.jobId);
    assert.equal((await jobs.find(discardAccount, secondAttempt.jobId))?.state, 'authorized');

    // Run second attempt into needs_verification and verify discarding needs_verification also works.
    submitMode = 'needs_verification';
    verifyMode = 'needs_verification';
    await discardWorker.tick(discardAccount);
    assert.equal((await jobs.find(discardAccount, secondAttempt.jobId))?.state, 'needs_verification');
    await discard.execute(discardAccount, task.taskId, secondAttempt.jobId);
    assert.deepEqual(discardedProofKeys, ['empty-dutic-proof.png', 'uncertain-proof.png']);
    assert.equal(await jobs.find(discardAccount, secondAttempt.jobId), null);

    // Re-authorize a third time with the same pdfId, verify concurrent in-flight verification blocks discard, then confirm it.
    submitMode = 'needs_verification';
    const thirdAttempt = await deliver.execute({ accountId: discardAccount, taskId: task.taskId, pdfId: pdf.pdfId });
    await discardWorker.tick(discardAccount);
    assert.equal((await jobs.find(discardAccount, thirdAttempt.jobId))?.state, 'needs_verification');

    let signalVerifyEntered!: () => void;
    const verifyEntered = new Promise<void>((resolve) => { signalVerifyEntered = resolve; });
    let releaseVerify!: () => void;
    const verifyHold = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const pausedVerifyWorker = new AcademicWorker(work, fetcher, {
      submit: customSender.submit,
      async verify(order) {
        signalVerifyEntered();
        await verifyHold;
        return {
          state: 'confirmed',
          evidence: {
            activityUrl: order.activityUrl,
            visibleStatus: 'Enviado para calificar',
            fileName: order.originalName,
            proofKey: 'confirmed-proof.png',
            capturedAt: '2026-11-26T10:15:00.000Z',
          },
        };
      },
    }, files, clock);

    await verify.execute(discardAccount, thirdAttempt.jobId);
    const inFlightTick = pausedVerifyWorker.tick(discardAccount);
    await verifyEntered;

    // Concurrent discard during active in-flight verification must be rejected as delivery_active.
    await assert.rejects(
      discard.execute(discardAccount, task.taskId, thirdAttempt.jobId),
      { code: 'delivery_active' },
    );

    releaseVerify();
    await inFlightTick;
    assert.equal((await jobs.find(discardAccount, thirdAttempt.jobId))?.state, 'confirmed');

    // Confirmed delivery cannot be discarded.
    await assert.rejects(
      discard.execute(discardAccount, task.taskId, thirdAttempt.jobId),
      { code: 'delivery_confirmed' },
    );
    assert.equal((await jobs.find(discardAccount, thirdAttempt.jobId))?.state, 'confirmed');
  });

  await suite.test('la pantalla MVC busca, carga, autoriza y renderiza la confirmación simulada', async () => {
    const app = await createApplication({
      databaseUrl: url.toString(), uploadDir: directory, demoMode: true,
      accountId: 'demo-local', host: '127.0.0.1', port: 0,
    }, false);
    try {
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      const alias = await fetch(origin + '/__demo', { redirect: 'manual' });
      assert.equal(alias.status, 302);
      assert.equal(alias.headers.get('location'), '/');
      async function post(path: string, body?: FormData | URLSearchParams) {
        const response = await fetch(origin + path, { method: 'POST', body, redirect: 'manual' });
        assert.equal(response.status, 303, await response.text());
        const location = response.headers.get('location');
        assert.ok(location);
        return location;
      }
      async function waitFor(path: string, expected: string) {
        let html = '';
        for (let index = 0; index < 50; index++) {
          const response = await fetch(origin + path);
          assert.equal(response.status, 200, await response.clone().text());
          html = await response.text();
          if (html.includes(expected)) return html;
          await sleep(100);
        }
        assert.fail('No apareció ' + expected + ' en ' + html);
      }

      await waitFor(await post('/busquedas'), 'Búsqueda completada');
      const list = await waitFor(await post('/busquedas'), 'Búsqueda completada');
      assert.equal(list.match(/Práctica de prueba/g)?.length, 1);
      const href = list.match(/href="(\/tareas\/[^"]+)"/)?.[1];
      assert.ok(href);
      const form = new FormData();
      form.set('pdf', new Blob([new Uint8Array(samplePdf())], { type: 'application/pdf' }), 'demo.pdf');
      await post(href + '/pdf', form);
      const task = await waitFor(href, 'PDF vigente: <strong>demo.pdf</strong>');
      const pdfId = task.match(/name="pdfId" value="([^"]+)"/)?.[1];
      assert.ok(pdfId);
      await post(href + '/entregas', new URLSearchParams({ pdfId }));
      const confirmation = await waitFor(href, 'Entrega simulada confirmada');
      assert.match(confirmation, /Archivo observado: <strong>demo\.pdf<\/strong>/);
      assert.match(confirmation, /Este PDF ya está entregado/);
    } finally {
      await app.close();
    }
  });
});
