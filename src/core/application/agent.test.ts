import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AutorizarPropuestaAgente, ConsultarCapturaEntrega, PoliticaAutomatizacion, PrepararEntregaAgente, RechazarPropuestaAgente,
} from './agent';
import { AgentDeliveryPolicy, AgentDeliveryProposal } from '../domain/agent-automation';
import { ApplicationError, JobView, TaskView } from '../domain/model';
import { AgentAutomationRepository } from './ports/agent';
import { JobRepository, PdfStore, ProofStore, TaskRepository } from './ports/persistence';
import { CargarPdf, ConsultarTrabajo, ListarTareas, SolicitarEntrega } from './tasks';

function setupHarness() {
  const tasks: TaskView[] = [
    {
      taskId: '11111111-1111-4111-8111-111111111111',
      externalId: '30',
      course: 'Métodos Numéricos GB',
      title: 'Tarea 3 — Interpolación',
      activityUrl: 'https://aula.example.edu/mod/assign/view.php?id=30',
      deadline: '2099-12-01T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
    {
      taskId: '22222222-2222-4222-8222-222222222222',
      externalId: '31',
      course: 'Ingeniería de Software',
      title: 'Tarea 3 — Patrones',
      activityUrl: 'https://aula.example.edu/mod/assign/view.php?id=31',
      deadline: '2099-12-02T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
  ];
  let policy: AgentDeliveryPolicy = 'confirm_in_panel';
  const proposals: AgentDeliveryProposal[] = [];
  const jobs = new Map<string, JobView>();
  const proofs = new Map<string, Uint8Array>();

  const taskRepo: TaskRepository = {
    list: async () => tasks,
    find: async (_acc, id) => tasks.find((t) => t.taskId === id) ?? null,
    attachPdf: async (_acc, taskId, pdf) => {
      const target = tasks.find((t) => t.taskId === taskId);
      if (!target) throw new ApplicationError('not_found', 'La tarea no existe.');
      target.currentPdf = { pdfId: pdf.pdfId, originalName: pdf.originalName, sha256: pdf.sha256 };
    },
  };
  const pdfStore: PdfStore = {
    write: async (content) => ({
      pdfId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      storageKey: 'a'.repeat(32) + '.pdf',
      sha256: 'b'.repeat(64),
      sizeBytes: content.byteLength,
    }),
    discard: async () => {},
    path: (key) => '/tmp/' + key,
    verifiedPath: async (key) => '/tmp/' + key,
  };
  const jobRepo: JobRepository = {
    queueSearch: async () => 'search-job',
    authorizeDelivery: async (_acc, taskId, pdfId) => {
      const jobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const target = tasks.find((t) => t.taskId === taskId)!;
      const view: JobView = { kind: 'delivery', jobId, state: 'authorized', summary: null, evidence: null, pdfId };
      target.delivery = view;
      jobs.set(jobId, view);
      return jobId;
    },
    requestVerification: async () => {},
    discardDelivery: async () => ({ proofStorageKey: null }),
    find: async (_acc, jobId) => jobs.get(jobId) ?? null,
  };
  const agentRepo: AgentAutomationRepository = {
    getPolicy: async () => policy,
    setPolicy: async (_acc, next) => { policy = next; return policy; },
    listProposals: async () => [...proposals],
    findProposal: async (_acc, id) => proposals.find((p) => p.proposalId === id) ?? null,
    createProposal: async (input) => {
      const target = tasks.find((t) => t.taskId === input.taskId)!;
      const created: AgentDeliveryProposal = {
        proposalId: 'pppppppp-pppp-4ppp-8ppp-pppppppppppp',
        accountId: input.accountId,
        source: input.source,
        instruction: input.instruction,
        taskId: input.taskId,
        taskTitle: target.title,
        taskCourse: target.course,
        pdfId: input.pdfId,
        pdfOriginalName: target.currentPdf!.originalName,
        pdfSha256: target.currentPdf!.sha256,
        state: 'pending',
        deliveryJobId: null,
        createdAt: '2026-11-26T02:00:00.000Z',
        updatedAt: '2026-11-26T02:00:00.000Z',
      };
      proposals.unshift(created);
      return created;
    },
    markAuthorized: async (_acc, proposalId, deliveryJobId) => {
      const found = proposals.find((p) => p.proposalId === proposalId);
      if (!found || found.state !== 'pending') throw new ApplicationError('proposal_not_pending', 'La propuesta ya fue procesada.');
      found.state = 'authorized';
      found.deliveryJobId = deliveryJobId;
      return found;
    },
    markRejected: async (_acc, proposalId) => {
      const found = proposals.find((p) => p.proposalId === proposalId);
      if (!found || found.state !== 'pending') throw new ApplicationError('proposal_not_pending', 'La propuesta ya fue procesada.');
      found.state = 'rejected';
      return found;
    },
  };
  const proofStore: ProofStore = {
    writePng: async (content) => {
      const key = 'c'.repeat(32) + '.png';
      proofs.set(key, content);
      return key;
    },
    readPng: async (key) => proofs.get(key) ?? null,
    discard: async (key) => { proofs.delete(key); },
  };

  const listTasks = new ListarTareas(taskRepo, () => new Date('2026-11-26T00:00:00.000Z'));
  const loadPdf = new CargarPdf(taskRepo, pdfStore);
  const deliver = new SolicitarEntrega(jobRepo);
  const findJob = new ConsultarTrabajo(jobRepo);

  return {
    tasks,
    jobs,
    proofs,
    policyUseCase: new PoliticaAutomatizacion(agentRepo),
    prepareUseCase: new PrepararEntregaAgente(listTasks, loadPdf, deliver, agentRepo),
    authorizeProposal: new AutorizarPropuestaAgente(agentRepo, deliver),
    rejectProposal: new RechazarPropuestaAgente(agentRepo),
    readProof: new ConsultarCapturaEntrega(findJob, proofStore),
  };
}

const validPdf = Buffer.from('%PDF-1.4\nhello world\n%%EOF\n');

test('PrepararEntregaAgente creates pending proposal under default confirm_in_panel policy and authorizes on panel click', async () => {
  const ctx = setupHarness();
  const prepared = await ctx.prepareUseCase.execute({
    accountId: 'acc-1',
    instruction: 'tengo mi pdf tareaMN.pdf subelo a la tarea 3 de mn',
    originalName: 'tareaMN.pdf',
    content: validPdf,
    source: 'codex-mcp',
    allowDirectExecution: true,
  });

  assert.equal(prepared.outcome, 'pending_confirmation');
  assert.equal(prepared.task.taskId, '11111111-1111-4111-8111-111111111111');
  assert.equal(prepared.proposal.state, 'pending');
  assert.equal(ctx.jobs.size, 0);

  const authorized = await ctx.authorizeProposal.execute('acc-1', prepared.proposal.proposalId);
  assert.equal(authorized.jobId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.equal(authorized.proposal.state, 'authorized');
});

test('PrepararEntregaAgente executes directly when policy is direct_on_exact_match and match is unambiguous', async () => {
  const ctx = setupHarness();
  await ctx.policyUseCase.set('acc-1', 'direct_on_exact_match');

  const prepared = await ctx.prepareUseCase.execute({
    accountId: 'acc-1',
    instruction: 'sube tareaMN.pdf a la tarea 3 de mn',
    originalName: 'tareaMN.pdf',
    content: validPdf,
    source: 'codex-mcp',
    allowDirectExecution: true,
  });

  assert.equal(prepared.outcome, 'authorized');
  assert.equal(prepared.jobId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.equal(prepared.proposal.state, 'authorized');
});

test('PrepararEntregaAgente refuses ambiguous instructions even under direct_on_exact_match', async () => {
  const ctx = setupHarness();
  await ctx.policyUseCase.set('acc-1', 'direct_on_exact_match');

  const prepared = await ctx.prepareUseCase.execute({
    accountId: 'acc-1',
    instruction: 'sube tareaMN.pdf a la tarea 3',
    originalName: 'tareaMN.pdf',
    content: validPdf,
    source: 'codex-mcp',
    allowDirectExecution: true,
  });

  assert.equal(prepared.outcome, 'ambiguous');
  assert.equal(prepared.candidates.length, 2);
  assert.equal(ctx.jobs.size, 0);
});

test('RechazarPropuestaAgente rejects pending proposal without authorizing delivery', async () => {
  const ctx = setupHarness();
  const prepared = await ctx.prepareUseCase.execute({
    accountId: 'acc-1',
    instruction: 'sube tareaMN.pdf a la tarea 3 de mn',
    originalName: 'tareaMN.pdf',
    content: validPdf,
    source: 'codex-mcp',
  });
  assert.equal(prepared.outcome, 'pending_confirmation');
  const rejected = await ctx.rejectProposal.execute('acc-1', prepared.proposal.proposalId);
  assert.equal(rejected.state, 'rejected');
  await assert.rejects(() => ctx.authorizeProposal.execute('acc-1', prepared.proposal.proposalId), { code: 'proposal_not_pending' });
});

test('ConsultarCapturaEntrega returns PNG proof only for delivery jobs with proofKey', async () => {
  const ctx = setupHarness();
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const key = 'c'.repeat(32) + '.png';
  ctx.proofs.set(key, pngBytes);
  ctx.jobs.set('job-proof', {
    kind: 'delivery',
    jobId: 'job-proof',
    state: 'confirmed',
    summary: 'Entrega confirmada.',
    evidence: {
      activityUrl: 'https://aula.example.edu/mod/assign/view.php?id=30',
      visibleStatus: 'Enviado para calificar',
      fileName: 'tareaMN.pdf',
      proofKey: key,
      capturedAt: '2026-11-26T02:10:00.000Z',
    },
  });

  const proof = await ctx.readProof.execute('acc-1', 'job-proof');
  assert.deepEqual(Buffer.from(proof.content), pngBytes);
  assert.equal(proof.fileName, 'tareaMN.pdf');

  await assert.rejects(() => ctx.readProof.execute('acc-1', 'missing-job'), { code: 'not_found' });
});

test('PrepararEntregaAgente rejects tasks with active delivery before storing PDF or creating dangling proposal', async () => {
  const ctx = setupHarness();
  ctx.tasks[0]!.delivery = {
    kind: 'delivery',
    jobId: 'active-job',
    state: 'running',
    summary: null,
    evidence: null,
    pdfId: 'existing-pdf',
  };
  await assert.rejects(
    () => ctx.prepareUseCase.execute({
      accountId: 'acc-1',
      instruction: 'sube tareaMN.pdf a la tarea 3 de mn',
      originalName: 'tareaMN.pdf',
      content: validPdf,
      source: 'codex-mcp',
      allowDirectExecution: true,
    }),
    { code: 'delivery_pending' },
  );
  assert.equal(ctx.tasks[0]!.currentPdf, null);
});
