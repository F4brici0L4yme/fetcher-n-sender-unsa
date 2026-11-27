import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';
import { ApplicationError } from '../../core/domain/model';
import { PostgresAgentAutomationRepository } from './agent-repository';
import {
  postgresDatabase,
  PostgresAccountRevisionRepository,
  PostgresAssignmentImportRepository,
  PostgresJobRepository,
  PostgresTaskRepository,
  PostgresWorkerRepository,
} from './repositories';
import { TASK_CHANGES_CHANNEL } from './task-changes';

test('agent automation policy, proposals, NOTIFY revisions, and delivery proofs persist cleanly in PostgreSQL', async (t) => {
  assert.ok(process.env.DATABASE_URL, 'Ejecuta test:integration dentro de Docker Compose.');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const database = 'agent_test_' + randomUUID().replaceAll('-', '');
  await admin.query('create database ' + database);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + database;
  const pool = new Pool({ connectionString: url.toString() });

  let listener: PoolClient | undefined;
  t.after(async () => {
    if (listener) {
      await listener.query('UNLISTEN ' + TASK_CHANGES_CHANNEL).catch(() => undefined);
      listener.release();
      listener = undefined;
    }
    await pool.end();
    await admin.query('drop database ' + database);
    await admin.end();
  });

  const db = postgresDatabase(pool);
  await migrate(db, { migrationsFolder: 'src/adapters/persistence/migrations' });
  await migrate(db, { migrationsFolder: 'src/adapters/persistence/migrations' });

  const agentRepo = new PostgresAgentAutomationRepository(db);
  const revisions = new PostgresAccountRevisionRepository(db);
  const imports = new PostgresAssignmentImportRepository(db);
  const tasks = new PostgresTaskRepository(db);
  const jobs = new PostgresJobRepository(db);
  const workerRepo = new PostgresWorkerRepository(pool);

  const activeListener = await pool.connect();
  listener = activeListener;
  await activeListener.query('LISTEN ' + TASK_CHANGES_CHANNEL);

  async function expectAccountMutation<T>(accountId: string, run: () => Promise<T>): Promise<T> {
    const before = await revisions.currentRevision(accountId);
    const notice = once(activeListener, 'notification', { signal: AbortSignal.timeout(5000) });
    const result = await run();
    const [event] = await notice as [{ channel: string; payload: string }];
    assert.equal(event.channel, TASK_CHANGES_CHANNEL);
    assert.equal(event.payload, accountId);
    const after = await revisions.currentRevision(accountId);
    assert.notEqual(after, before);
    return result;
  }

  // 1. Default policy is confirm_in_panel when no row exists yet
  assert.equal(await agentRepo.getPolicy('acc-a'), 'confirm_in_panel');
  assert.equal(await agentRepo.getPolicy('acc-b'), 'confirm_in_panel');

  // 2. setPolicy upserts row, increments account_revisions, and fires NOTIFY
  const updatedPolicy = await expectAccountMutation('acc-a', () =>
    agentRepo.setPolicy('acc-a', 'direct_on_exact_match'),
  );
  assert.equal(updatedPolicy, 'direct_on_exact_match');
  assert.equal(await agentRepo.getPolicy('acc-a'), 'direct_on_exact_match');
  assert.equal(await agentRepo.getPolicy('acc-b'), 'confirm_in_panel');
  assert.equal(await revisions.currentRevision('acc-b'), 'acc-b:0');

  const revertedPolicy = await expectAccountMutation('acc-a', () =>
    agentRepo.setPolicy('acc-a', 'confirm_in_panel'),
  );
  assert.equal(revertedPolicy, 'confirm_in_panel');
  assert.equal(await agentRepo.getPolicy('acc-a'), 'confirm_in_panel');

  // 3. Seed tasks and PDFs for acc-a and acc-b
  await imports.recordImport('acc-a', [
    {
      externalId: 'ext-30',
      course: 'Métodos Numéricos GB',
      title: 'Tarea 3 — Interpolación',
      activityUrl: 'https://aula.example.invalid/mod/assign/view.php?id=30',
      deadline: '2099-12-01T04:59:00.000Z',
      destination: 'aula_virtual',
    },
    {
      externalId: 'ext-31',
      course: 'Métodos Numéricos GB',
      title: 'Tarea 4 — Integración',
      activityUrl: 'https://aula.example.invalid/mod/assign/view.php?id=31',
      deadline: '2099-12-10T04:59:00.000Z',
      destination: 'aula_virtual',
    },
  ]);
  await imports.recordImport('acc-b', [
    {
      externalId: 'ext-99',
      course: 'Otro Curso',
      title: 'Tarea B',
      activityUrl: 'https://aula.example.invalid/mod/assign/view.php?id=99',
      deadline: '2099-12-15T04:59:00.000Z',
      destination: 'aula_virtual',
    },
  ]);

  const accATasks = await tasks.list('acc-a');
  const task1 = accATasks.find((item) => item.externalId === 'ext-30')!;
  const task2 = accATasks.find((item) => item.externalId === 'ext-31')!;
  const [taskB] = await tasks.list('acc-b');
  assert.ok(task1 && task2 && taskB);

  const pdf1Id = randomUUID();
  const pdf2Id = randomUUID();
  const pdfBId = randomUUID();
  await tasks.attachPdf('acc-a', task1.taskId, {
    pdfId: pdf1Id,
    originalName: 'tareaMN.pdf',
    storageKey: pdf1Id.replaceAll('-', '') + '.pdf',
    sha256: '1'.repeat(64),
    sizeBytes: 1024,
  });
  await tasks.attachPdf('acc-a', task2.taskId, {
    pdfId: pdf2Id,
    originalName: 'tarea4MN.pdf',
    storageKey: pdf2Id.replaceAll('-', '') + '.pdf',
    sha256: '2'.repeat(64),
    sizeBytes: 2048,
  });
  await tasks.attachPdf('acc-b', taskB.taskId, {
    pdfId: pdfBId,
    originalName: 'otro.pdf',
    storageKey: pdfBId.replaceAll('-', '') + '.pdf',
    sha256: '3'.repeat(64),
    sizeBytes: 512,
  });

  // 4. createProposal validates ownership and task/pdf binding
  const isNotFound = (error: unknown) => error instanceof ApplicationError && error.code === 'not_found';
  await assert.rejects(
    () => agentRepo.createProposal({
      accountId: 'acc-a',
      source: 'codex-mcp',
      instruction: 'Cross-account task',
      taskId: taskB.taskId,
      pdfId: pdfBId,
    }),
    isNotFound,
  );
  await assert.rejects(
    () => agentRepo.createProposal({
      accountId: 'acc-a',
      source: 'codex-mcp',
      instruction: 'Cross-task PDF mismatch',
      taskId: task1.taskId,
      pdfId: pdf2Id,
    }),
    isNotFound,
  );

  // 5. createProposal + listProposals + findProposal
  const proposal1 = await expectAccountMutation('acc-a', () =>
    agentRepo.createProposal({
      accountId: 'acc-a',
      source: 'codex-mcp',
      instruction: 'subelo a la tarea 3 de mn',
      taskId: task1.taskId,
      pdfId: pdf1Id,
    }),
  );
  assert.equal(proposal1.accountId, 'acc-a');
  assert.equal(proposal1.source, 'codex-mcp');
  assert.equal(proposal1.instruction, 'subelo a la tarea 3 de mn');
  assert.equal(proposal1.taskId, task1.taskId);
  assert.equal(proposal1.taskTitle, 'Tarea 3 — Interpolación');
  assert.equal(proposal1.taskCourse, 'Métodos Numéricos GB');
  assert.equal(proposal1.pdfId, pdf1Id);
  assert.equal(proposal1.pdfOriginalName, 'tareaMN.pdf');
  assert.equal(proposal1.pdfSha256, '1'.repeat(64));
  assert.equal(proposal1.state, 'pending');
  assert.equal(proposal1.deliveryJobId, null);
  assert.ok(!Number.isNaN(Date.parse(proposal1.createdAt)));
  assert.ok(!Number.isNaN(Date.parse(proposal1.updatedAt)));

  const proposal2 = await expectAccountMutation('acc-a', () =>
    agentRepo.createProposal({
      accountId: 'acc-a',
      source: 'panel',
      instruction: 'subelo a la tarea 4 de mn',
      taskId: task2.taskId,
      pdfId: pdf2Id,
    }),
  );

  const listedA = await agentRepo.listProposals('acc-a');
  assert.equal(listedA.length, 2);
  assert.equal(listedA[0]?.proposalId, proposal2.proposalId);
  assert.equal(listedA[1]?.proposalId, proposal1.proposalId);
  assert.equal((await agentRepo.listProposals('acc-a', 1)).length, 1);
  assert.deepEqual(await agentRepo.listProposals('acc-b'), []);

  assert.deepEqual(await agentRepo.findProposal('acc-a', proposal1.proposalId), proposal1);
  assert.equal(await agentRepo.findProposal('acc-b', proposal1.proposalId), null);
  assert.equal(await agentRepo.findProposal('acc-a', 'not-a-uuid'), null);

  // 6. markAuthorized + duplicate transition rejection + markRejected
  const deliveryJobId = await jobs.authorizeDelivery('acc-a', task1.taskId, pdf1Id);
  const authorized = await expectAccountMutation('acc-a', () =>
    agentRepo.markAuthorized('acc-a', proposal1.proposalId, deliveryJobId),
  );
  assert.equal(authorized.state, 'authorized');
  assert.equal(authorized.deliveryJobId, deliveryJobId);
  assert.equal(authorized.taskTitle, 'Tarea 3 — Interpolación');
  assert.equal(authorized.pdfOriginalName, 'tareaMN.pdf');

  const isNotPending = (error: unknown) =>
    error instanceof ApplicationError
    && error.code === 'proposal_not_pending'
    && error.message === 'La propuesta ya fue procesada.';

  await assert.rejects(() => agentRepo.markAuthorized('acc-a', proposal1.proposalId, deliveryJobId), isNotPending);
  await assert.rejects(() => agentRepo.markRejected('acc-a', proposal1.proposalId), isNotPending);
  await assert.rejects(() => agentRepo.markRejected('acc-b', proposal2.proposalId), isNotFound);

  const rejected = await expectAccountMutation('acc-a', () =>
    agentRepo.markRejected('acc-a', proposal2.proposalId),
  );
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.deliveryJobId, null);
  await assert.rejects(() => agentRepo.markRejected('acc-a', proposal2.proposalId), isNotPending);
  await assert.rejects(() => agentRepo.markAuthorized('acc-a', proposal2.proposalId, deliveryJobId), isNotPending);

  // Concurrent race on pending proposal: exactly one transition wins
  const proposal3 = await agentRepo.createProposal({
    accountId: 'acc-a',
    source: 'codex-mcp',
    instruction: 'race test',
    taskId: task1.taskId,
    pdfId: pdf1Id,
  });
  const outcomes = await Promise.allSettled([
    agentRepo.markAuthorized('acc-a', proposal3.proposalId, deliveryJobId),
    agentRepo.markRejected('acc-a', proposal3.proposalId),
  ]);
  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const failed = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(failed.length, 1);
  assert.ok(isNotPending(failed[0]?.reason));

  // 7. settleDelivery persists proofKey + capturedAt and jobView reads them back
  const proofKey = 'a'.repeat(32) + '.png';
  const capturedAt = '2026-11-26T03:15:00.000Z';
  await workerRepo.withAccountLock('acc-a', async (session) => {
    const claimed = await session.claimNext();
    assert.equal(claimed?.kind, 'delivery');
    assert.equal(claimed.order.jobId, deliveryJobId);
    await session.settleDelivery(deliveryJobId, 'running', 'confirmed', 'Entrega confirmada.', {
      activityUrl: task1.activityUrl,
      visibleStatus: 'Enviado para calificar',
      fileName: 'tareaMN.pdf',
      portalReference: 'ref-42',
      proofKey,
      capturedAt,
    });
  });

  const jobView = await jobs.find('acc-a', deliveryJobId);
  assert.equal(jobView?.kind, 'delivery');
  assert.equal(jobView.state, 'confirmed');
  assert.equal(jobView.evidence?.proofKey, proofKey);
  assert.equal(jobView.evidence?.capturedAt, capturedAt);
  assert.equal(jobView.evidence?.portalReference, 'ref-42');

  const taskView = await tasks.find('acc-a', task1.taskId);
  assert.equal(taskView?.delivery?.evidence?.proofKey, proofKey);
  assert.equal(taskView?.delivery?.evidence?.capturedAt, capturedAt);

  // 8. Rolled-back transaction on account_automation_settings must not advance revision
  const beforeRollback = await revisions.currentRevision('acc-a');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      "update account_automation_settings set delivery_policy = 'direct_on_exact_match' where account_id = 'acc-a'",
    );
    await client.query('rollback');
  } finally {
    client.release();
  }
  assert.equal(await revisions.currentRevision('acc-a'), beforeRollback);
});
