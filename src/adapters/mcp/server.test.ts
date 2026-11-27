import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { Request, Response } from 'express';
import { AgentDeliveryPolicy, AgentDeliveryProposal } from '../../core/domain/agent-automation';
import { TaskView } from '../../core/domain/model';
import { runAgentCli } from '../../bootstrap/agent-cli';
import { McpHttpController } from '../web/controllers/mcp-http.controller';
import {
  AulaPanelClient,
  AulaPanelError,
  findLocalPdfs,
  parseBase64Pdf,
  readHostPdf,
  resolveDeliveryPdfTarget,
  resolveLocalPanelUrl,
  resolveUserPath,
} from './client';
import { AulaMcpServer, serveStdio } from './server';

// Minimal valid 1x1 PNG bytes (8-byte PNG signature + IHDR + IDAT + IEND).
const SAMPLE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000d49444154789c6360000000020001e221bc330000000049454e44ae426082',
  'hex',
);

const SAMPLE_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'ascii');
const SAMPLE_PDF_SHA256 = createHash('sha256').update(SAMPLE_PDF).digest('hex');

const TASK_MN: TaskView = {
  taskId: '11111111-1111-4111-8111-111111111111',
  externalId: '30',
  course: 'Métodos Numéricos GB',
  title: 'Tarea 3 — Interpolación',
  activityUrl: 'https://aula.example.edu/mod/assign/view.php?id=30',
  deadline: '2099-12-01T04:59:00.000Z',
  destination: 'aula_virtual',
  currentPdf: null,
  delivery: null,
};

const TASK_IS: TaskView = {
  taskId: '22222222-2222-4222-8222-222222222222',
  externalId: '31',
  course: 'Ingeniería de Software',
  title: 'Tarea 3 — Patrones',
  activityUrl: 'https://aula.example.edu/mod/assign/view.php?id=31',
  deadline: '2099-12-02T04:59:00.000Z',
  destination: 'aula_virtual',
  currentPdf: null,
  delivery: null,
};

interface RecordedDeliveryUpload {
  fileName: string;
  fileBytes: Buffer;
  instruction: string;
  taskId: string | null;
  source: string | null;
  executeIfAllowed: string | null;
}

interface StubState {
  policy: AgentDeliveryPolicy;
  deliverOutcomeOverride?: 'no_match' | 'ambiguous';
  syncPollCount: number;
  deliveryPollCount: number;
  uploads: RecordedDeliveryUpload[];
  authorizedJobs: string[];
  discardedDeliveries: Array<{ taskId: string; jobId: string }>;
  notes: Array<{
    noteId: string;
    title: string;
    description: string;
    priority: 'alta' | 'media' | 'baja';
    deadline: string | null;
    status: 'pendiente' | 'completado';
  }>;
  lastTaskQuery: string | null;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function startStubPanel() {
  const state: StubState = {
    policy: 'confirm_in_panel',
    syncPollCount: 0,
    deliveryPollCount: 0,
    uploads: [],
    authorizedJobs: [],
    discardedDeliveries: [],
    notes: [
      {
        noteId: 'note-1',
        title: 'Repasar spline cúbico',
        description: 'Ejercicios del capítulo 4',
        priority: 'alta',
        deadline: '2099-11-30',
        status: 'pendiente',
      },
    ],
    lastTaskQuery: null,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === 'GET' && url.pathname === '/api/agente/estado') {
        return json(200, {
          accountId: 'acc-local-1',
          session: { state: 'connected', busy: false, message: 'Sesión activa de estudiante@unsa.edu.pe' },
          policy: state.policy,
          autoSync: {
            enabled: true,
            intervalSeconds: 180,
            lastSyncAt: '2026-11-26T01:55:00.000Z',
            nextSyncAt: '2026-11-26T01:58:00.000Z',
            running: false,
          },
          counts: {
            pendingTasks: 2,
            completedTasks: 1,
            pendingProposals: 0,
            pendingNotes: state.notes.filter((n) => n.status === 'pendiente').length,
          },
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/agente/tareas') {
        const q = url.searchParams.get('q');
        state.lastTaskQuery = q;
        const payload: Record<string, unknown> = {
          accountId: 'acc-local-1',
          tasks: [TASK_MN, TASK_IS],
        };
        if (q) {
          payload.match = {
            kind: 'exact',
            pdfHint: null,
            candidates: [{ task: TASK_MN, score: 80, reasons: ['sigla de curso (MN)', 'número 3'] }],
          };
        }
        return json(200, payload);
      }

      if (req.method === 'POST' && url.pathname === '/api/agente/analizar') {
        const raw = JSON.parse((await readBody(req)).toString('utf8')) as { instruction?: string };
        return json(200, {
          kind: 'exact',
          pdfHint: 'tareaMN.pdf',
          match: { task: TASK_MN, score: 80, reasons: ['sigla de curso (MN)', 'número 3'] },
          candidates: [{ task: TASK_MN, score: 80, reasons: ['sigla de curso (MN)', 'número 3'] }],
          instructionEcho: raw.instruction,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/agente/sincronizar') {
        state.syncPollCount = 0;
        return json(202, { jobId: 'sync-job-1' });
      }

      if (req.method === 'POST' && url.pathname === '/api/agente/entregas') {
        const body = await readBody(req);
        const contentType = req.headers['content-type'] ?? '';
        const form = await new Response(new Uint8Array(body), {
          headers: { 'content-type': contentType },
        }).formData();
        const file = form.get('pdf');
        assert.ok(file instanceof File, 'Expected multipart field "pdf" to be a File');
        const fileBytes = Buffer.from(await file.arrayBuffer());
        const instruction = String(form.get('instruction') ?? '');
        const taskId = form.get('taskId') ? String(form.get('taskId')) : null;
        const source = form.get('source') ? String(form.get('source')) : null;
        const executeIfAllowed = form.get('executeIfAllowed') ? String(form.get('executeIfAllowed')) : null;

        state.uploads.push({
          fileName: file.name,
          fileBytes,
          instruction,
          taskId,
          source,
          executeIfAllowed,
        });

        if (state.deliverOutcomeOverride === 'no_match') {
          return json(200, {
            outcome: 'no_match',
            policy: state.policy,
            pdfHint: file.name,
            candidates: [],
          });
        }

        if (state.deliverOutcomeOverride === 'ambiguous') {
          return json(200, {
            outcome: 'ambiguous',
            policy: state.policy,
            pdfHint: file.name,
            candidates: [
              { task: TASK_MN, score: 46, reasons: ['número 3', 'título (tarea)'] },
              { task: TASK_IS, score: 46, reasons: ['número 3', 'título (tarea)'] },
            ],
          });
        }

        const sha256 = createHash('sha256').update(fileBytes).digest('hex');
        const pdf = {
          pdfId: 'pdf-1111',
          originalName: file.name,
          sha256,
        };
        const baseProposal: AgentDeliveryProposal = {
          proposalId: 'prop-1111',
          accountId: 'acc-local-1',
          source: source ?? 'ai-mcp',
          instruction,
          taskId: taskId ?? TASK_MN.taskId,
          taskTitle: TASK_MN.title,
          taskCourse: TASK_MN.course,
          pdfId: pdf.pdfId,
          pdfOriginalName: pdf.originalName,
          pdfSha256: pdf.sha256,
          state: 'pending',
          deliveryJobId: null,
          createdAt: '2026-11-26T02:00:00.000Z',
          updatedAt: '2026-11-26T02:00:00.000Z',
        };

        if (state.policy === 'direct_on_exact_match' && executeIfAllowed === 'true') {
          const jobId = 'delivery-job-1';
          state.deliveryPollCount = 0;
          state.authorizedJobs.push(jobId);
          return json(200, {
            outcome: 'authorized',
            policy: state.policy,
            proposal: { ...baseProposal, state: 'authorized', deliveryJobId: jobId },
            jobId,
            task: TASK_MN,
            pdf,
          });
        }

        const address = server.address() as AddressInfo;
        return json(200, {
          outcome: 'pending_confirmation',
          policy: state.policy,
          proposal: baseProposal,
          task: TASK_MN,
          pdf,
          panelUrl: `http://127.0.0.1:${address.port}/agente`,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/agente/propuestas/prop-1111/autorizar') {
        state.authorizedJobs.push('delivery-job-1');
        return json(200, {
          jobId: 'delivery-job-1',
          proposal: {
            proposalId: 'prop-1111',
            accountId: 'acc-local-1',
            source: 'ai-mcp',
            instruction: 'sube tareaMN.pdf a tarea 3 de mn',
            taskId: TASK_MN.taskId,
            taskTitle: TASK_MN.title,
            taskCourse: TASK_MN.course,
            pdfId: 'pdf-1111',
            pdfOriginalName: 'tareaMN.pdf',
            pdfSha256: SAMPLE_PDF_SHA256,
            state: 'authorized',
            deliveryJobId: 'delivery-job-1',
            createdAt: '2026-11-26T02:00:00.000Z',
            updatedAt: '2026-11-26T02:01:00.000Z',
          },
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/agente/trabajos/sync-job-1') {
        state.syncPollCount += 1;
        if (state.syncPollCount < 2) {
          return json(200, {
            jobId: 'sync-job-1',
            kind: 'search',
            state: 'running',
            label: 'Buscando tareas',
            active: true,
            summary: null,
          });
        }
        return json(200, {
          jobId: 'sync-job-1',
          kind: 'search',
          state: 'completed',
          label: 'Búsqueda completada',
          active: false,
          summary: 'Se actualizaron 2 tareas pendientes.',
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/agente/trabajos/delivery-job-1') {
        state.deliveryPollCount += 1;
        if (state.deliveryPollCount < 2) {
          return json(200, {
            jobId: 'delivery-job-1',
            kind: 'delivery',
            state: 'running',
            label: 'Enviando PDF',
            active: true,
            summary: null,
            evidence: null,
            proofUrl: null,
          });
        }
        return json(200, {
          jobId: 'delivery-job-1',
          kind: 'delivery',
          state: 'confirmed',
          label: 'Entrega confirmada',
          active: false,
          summary: 'Entrega confirmada en Moodle y movida a Completadas.',
          evidence: {
            activityUrl: TASK_MN.activityUrl,
            visibleStatus: 'Enviado para calificar',
            fileName: 'tareaMN.pdf',
            proofKey: 'proof-key-1.png',
            capturedAt: '2026-11-26T02:05:00.000Z',
          },
          proofUrl: '/entregas/delivery-job-1/captura',
        });
      }

      if (req.method === 'GET' && url.pathname === '/entregas/delivery-job-1/captura') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(SAMPLE_PNG);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/entregas/no-proof/captura') {
        return json(404, { error: 'No existe captura.' });
      }

      if (req.method === 'GET' && url.pathname === '/entregas/bad-png/captura') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end('not-a-valid-png');
        return;
      }

      if (req.method === 'DELETE') {
        const discardMatch = url.pathname.match(/^\/api\/agente\/tareas\/([^/]+)\/entregas\/([^/]+)$/);
        if (discardMatch) {
          const taskId = decodeURIComponent(discardMatch[1]!);
          const jobId = decodeURIComponent(discardMatch[2]!);
          state.discardedDeliveries.push({ taskId, jobId });
          return json(200, { jobId });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/agente/notas') {
        return json(200, {
          accountId: 'acc-local-1',
          notes: state.notes,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/agente/notas') {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          title: string;
          description?: string;
          priority: 'alta' | 'media' | 'baja';
          deadline?: string | null;
          status?: 'pendiente' | 'completado';
        };
        const created = {
          noteId: `note-${state.notes.length + 1}`,
          title: body.title,
          description: body.description ?? '',
          priority: body.priority,
          deadline: body.deadline ?? null,
          status: body.status ?? 'pendiente',
        };
        state.notes.push(created);
        return json(201, { note: created });
      }

      return json(404, { error: `Ruta no encontrada: ${req.method} ${url.pathname}` });
    } catch (error) {
      return json(500, { error: error instanceof Error ? error.message : 'Stub failure' });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    state,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('resolveLocalPanelUrl accepts loopback HTTP URLs and rejects remote or non-HTTP URLs', () => {
  assert.equal(resolveLocalPanelUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(resolveLocalPanelUrl('http://localhost:4100'), 'http://localhost:4100');
  assert.equal(resolveLocalPanelUrl('http://[::1]:3000/'), 'http://[::1]:3000');

  for (const unsafe of [
    'https://evil.example',
    'https://127.0.0.1:3000',
    'http://192.168.1.5:3000',
    'http://0.0.0.0:3000',
    'http://127.0.0.1.evil.example:3000',
    'http://user:pass@127.0.0.1:3000',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => resolveLocalPanelUrl(unsafe), /loopback|local|http/i, `Expected rejection for ${unsafe}`);
  }
});

test('readHostPdf validates real PDF, rejects non-PDF, symlinks, missing files, and expands ~/', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-pdf-'));
  try {
    const validPath = path.join(dir, 'tareaMN.pdf');
    await writeFile(validPath, SAMPLE_PDF);

    const loaded = await readHostPdf(validPath);
    assert.equal(loaded.resolvedPath, validPath);
    assert.equal(loaded.originalName, 'tareaMN.pdf');
    assert.equal(loaded.sizeBytes, SAMPLE_PDF.byteLength);
    assert.equal(loaded.sha256, SAMPLE_PDF_SHA256);
    assert.deepEqual(loaded.content, SAMPLE_PDF);

    const nonPdfPath = path.join(dir, 'fake.pdf');
    await writeFile(nonPdfPath, 'not a pdf file at all 1234567890');
    await assert.rejects(() => readHostPdf(nonPdfPath), /PDF/i);

    const missingEofPath = path.join(dir, 'truncated.pdf');
    await writeFile(missingEofPath, '%PDF-1.4\ntruncated without trailer');
    await assert.rejects(() => readHostPdf(missingEofPath), /PDF/i);

    const tinyPath = path.join(dir, 'tiny.pdf');
    await writeFile(tinyPath, '%PDF-1.4\n%%EOF');
    // 14 bytes is minimum; 13 bytes must be rejected.
    const tooSmallPath = path.join(dir, 'toosmall.pdf');
    await writeFile(tooSmallPath, '%PDF-1\n%%EOF');
    await assert.rejects(() => readHostPdf(tooSmallPath), /PDF|tamaño|bytes/i);
    assert.equal((await readHostPdf(tinyPath)).sizeBytes, 14);

    const linkPath = path.join(dir, 'link.pdf');
    await symlink(validPath, linkPath);
    await assert.rejects(() => readHostPdf(linkPath), /enlace simbólico|symlink/i);

    await assert.rejects(() => readHostPdf(path.join(dir, 'does-not-exist.pdf')), /encontr|existe/i);
    await assert.rejects(() => readHostPdf(''), /ruta/i);
    await assert.rejects(() => readHostPdf('~/definitely-missing-aula-pdf-9f8e7d.pdf'), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(os.homedir()), `Expected expanded homedir in error: ${err.message}`);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP server handles initialize, notifications/initialized (no reply), ping, and tools/list with annotations', async () => {
  const stub = await startStubPanel();
  try {
    const client = new AulaPanelClient(stub.baseUrl);
    const server = new AulaMcpServer(client, { waitOptions: { pollMs: 10, timeoutMs: 2000 } });

    const init = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '0.1.0' } },
    });
    assert.ok(init && 'result' in init);
    const initResult = init.result as {
      protocolVersion: string;
      capabilities: { tools: Record<string, unknown> };
      serverInfo: { name: string; version: string };
    };
    assert.equal(initResult.protocolVersion, '2025-06-18');
    assert.deepEqual(initResult.capabilities, { tools: {} });
    assert.deepEqual(initResult.serverInfo, { name: 'aula-virtual-unsa', version: '1.0.0' });

    const notifReply = await server.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    assert.equal(notifReply, null);

    const pingReply = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.deepEqual(pingReply, { jsonrpc: '2.0', id: 2, result: {} });

    const listed = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.ok(listed && 'result' in listed);
    const tools = (listed.result as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> }> }).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        'aula_status',
        'aula_list_tasks',
        'aula_sync_tasks',
        'aula_find_local_pdfs',
        'aula_deliver_pdf',
        'aula_check_job',
        'aula_discard_delivery',
        'aula_list_notes',
        'aula_create_note',
      ],
    );
    for (const tool of tools) {
      assert.ok(tool.description.length > 10);
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.annotations, `Missing annotations on ${tool.name}`);
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
      assert.equal(typeof tool.annotations.destructiveHint, 'boolean');
      assert.equal(typeof tool.annotations.idempotentHint, 'boolean');
      assert.equal(typeof tool.annotations.openWorldHint, 'boolean');
      const serialized = JSON.stringify(tool);
      assert.doesNotMatch(serialized, /\/home\/|\/users\//i, `Tool ${tool.name} must not contain personal host paths`);
    }

    const findTool = tools.find((t) => t.name === 'aula_find_local_pdfs')!;
    assert.equal(findTool.annotations?.readOnlyHint, true);
    assert.equal(findTool.annotations?.destructiveHint, false);
    assert.equal(findTool.annotations?.idempotentHint, true);
    assert.equal(findTool.annotations?.openWorldHint, false);
    assert.equal(findTool.inputSchema.required, undefined);

    const deliverTool = tools.find((t) => t.name === 'aula_deliver_pdf')!;
    assert.equal(deliverTool.annotations?.destructiveHint, true);
    assert.equal(deliverTool.annotations?.readOnlyHint, false);
    assert.deepEqual(deliverTool.inputSchema.required, ['instruction']);

    const discardTool = tools.find((t) => t.name === 'aula_discard_delivery')!;
    assert.equal(discardTool.annotations?.readOnlyHint, false);
    assert.equal(discardTool.annotations?.destructiveHint, false);
    assert.equal(discardTool.annotations?.idempotentHint, true);
    assert.equal(discardTool.annotations?.openWorldHint, false);
    assert.deepEqual(discardTool.inputSchema.required, ['taskId', 'jobId']);

    const statusTool = tools.find((t) => t.name === 'aula_status')!;
    assert.equal(statusTool.annotations?.readOnlyHint, true);
    assert.equal(statusTool.annotations?.destructiveHint, false);
  } finally {
    await stub.close();
  }
});

test('MCP tools aula_status, aula_list_tasks, and aula_sync_tasks interact with local panel API', async () => {
  const stub = await startStubPanel();
  try {
    const client = new AulaPanelClient(stub.baseUrl);
    const server = new AulaMcpServer(client, { waitOptions: { pollMs: 10, timeoutMs: 2000 } });

    const statusRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'aula_status', arguments: {} },
    });
    assert.ok(statusRes && 'result' in statusRes);
    const statusPayload = statusRes.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
      structuredContent: { accountId: string; policy: string; counts: { pendingTasks: number } };
    };
    assert.notEqual(statusPayload.isError, true);
    assert.equal(statusPayload.structuredContent.accountId, 'acc-local-1');
    assert.equal(statusPayload.structuredContent.policy, 'confirm_in_panel');
    assert.equal(statusPayload.structuredContent.counts.pendingTasks, 2);

    const listRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'aula_list_tasks', arguments: { query: 'tarea 3 de mn' } },
    });
    assert.ok(listRes && 'result' in listRes);
    assert.equal(stub.state.lastTaskQuery, 'tarea 3 de mn');
    const listPayload = listRes.result as {
      structuredContent: { tasks: TaskView[]; match?: { kind: string } };
    };
    assert.equal(listPayload.structuredContent.tasks.length, 2);
    assert.equal(listPayload.structuredContent.match?.kind, 'exact');

    const syncRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'aula_sync_tasks', arguments: { wait: true } },
    });
    assert.ok(syncRes && 'result' in syncRes);
    const syncPayload = syncRes.result as {
      structuredContent: { jobId: string; job: { state: string; active: boolean } };
    };
    assert.equal(syncPayload.structuredContent.jobId, 'sync-job-1');
    assert.equal(syncPayload.structuredContent.job.state, 'completed');
    assert.equal(syncPayload.structuredContent.job.active, false);
    assert.equal(stub.state.syncPollCount, 2);
  } finally {
    await stub.close();
  }
});

test('aula_deliver_pdf returns pending proposal and panel link under confirm_in_panel policy', async () => {
  const stub = await startStubPanel();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-deliv-'));
  try {
    const pdfPath = path.join(dir, 'tareaMN.pdf');
    await writeFile(pdfPath, SAMPLE_PDF);

    const client = new AulaPanelClient(stub.baseUrl);
    const server = new AulaMcpServer(client, { waitOptions: { pollMs: 10, timeoutMs: 2000 } });

    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: {
          filePath: pdfPath,
          instruction: 'tengo mi pdf en ~/mn/tareaMN.pdf subelo a la tarea 3 de mn',
        },
      },
    });

    assert.ok(res && 'result' in res);
    const result = res.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
      structuredContent: { outcome: string; proposal: { proposalId: string }; panelUrl: string };
    };
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.outcome, 'pending_confirmation');
    assert.equal(result.structuredContent.proposal.proposalId, 'prop-1111');
    assert.equal(result.structuredContent.panelUrl, `${stub.baseUrl}/agente`);
    assert.match(result.content[0]?.text ?? '', /\/agente/);
    assert.equal(stub.state.authorizedJobs.length, 0);
    assert.equal(stub.state.uploads.length, 1);
    assert.equal(stub.state.uploads[0]?.fileName, 'tareaMN.pdf');
    assert.equal(stub.state.uploads[0]?.source, 'ai-mcp');
    assert.equal(stub.state.uploads[0]?.executeIfAllowed, 'true');
    assert.deepEqual(stub.state.uploads[0]?.fileBytes, SAMPLE_PDF);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('aula_deliver_pdf returns ranked candidates without delivering when instruction is ambiguous', async () => {
  const stub = await startStubPanel();
  stub.state.policy = 'direct_on_exact_match';
  stub.state.deliverOutcomeOverride = 'ambiguous';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-ambig-'));
  try {
    const pdfPath = path.join(dir, 'tareaMN.pdf');
    await writeFile(pdfPath, SAMPLE_PDF);

    const client = new AulaPanelClient(stub.baseUrl);
    const server = new AulaMcpServer(client, { waitOptions: { pollMs: 10, timeoutMs: 2000 } });

    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: {
          filePath: pdfPath,
          instruction: 'sube tareaMN.pdf a la tarea 3',
        },
      },
    });

    assert.ok(res && 'result' in res);
    const result = res.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
      structuredContent: { outcome: string; candidates: Array<{ task: TaskView }> };
    };
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.outcome, 'ambiguous');
    assert.equal(result.structuredContent.candidates.length, 2);
    assert.equal(stub.state.authorizedJobs.length, 0);
    assert.match(result.content[0]?.text ?? '', /11111111-1111-4111-8111-111111111111/);
    assert.match(result.content[0]?.text ?? '', /22222222-2222-4222-8222-222222222222/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('aula_deliver_pdf under direct_on_exact_match waits for confirmed job and returns inline PNG proof', async () => {
  const stub = await startStubPanel();
  stub.state.policy = 'direct_on_exact_match';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-direct-'));
  try {
    const pdfPath = path.join(dir, 'tareaMN.pdf');
    await writeFile(pdfPath, SAMPLE_PDF);

    const client = new AulaPanelClient(stub.baseUrl);
    const server = new AulaMcpServer(client, { waitOptions: { pollMs: 10, timeoutMs: 2000 } });

    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: {
          filePath: pdfPath,
          instruction: 'tengo mi pdf en ~/mn/tareaMN.pdf subelo a la tarea 3 de mn',
        },
      },
    });

    assert.ok(res && 'result' in res);
    const result = res.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      structuredContent: { outcome: string; jobId: string; job: { state: string }; hasProofImage: boolean };
    };
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.outcome, 'authorized');
    assert.equal(result.structuredContent.jobId, 'delivery-job-1');
    assert.equal(result.structuredContent.job.state, 'confirmed');
    assert.equal(result.structuredContent.hasProofImage, true);
    assert.equal(stub.state.deliveryPollCount, 2);

    const textBlock = result.content.find((block) => block.type === 'text');
    const imageBlock = result.content.find((block) => block.type === 'image');
    assert.ok(textBlock?.text?.includes('Enviado para calificar'));
    assert.ok(imageBlock, 'Expected inline image block in MCP tool response');
    assert.equal(imageBlock.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(imageBlock.data ?? '', 'base64'), SAMPLE_PNG);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('aula_check_job returns proof screenshot and aula_list_notes / aula_create_note manage notes', async () => {
  const stub = await startStubPanel();
  stub.state.deliveryPollCount = 2; // already confirmed
  try {
    const client = new AulaPanelClient(stub.baseUrl);
    const server = new AulaMcpServer(client, { waitOptions: { pollMs: 10, timeoutMs: 2000 } });

    const jobWithShot = await server.handleMessage({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'aula_check_job', arguments: { jobId: 'delivery-job-1' } },
    });
    assert.ok(jobWithShot && 'result' in jobWithShot);
    const shotResult = jobWithShot.result as {
      content: Array<{ type: string; mimeType?: string; data?: string }>;
      structuredContent: { job: { state: string }; hasProofImage: boolean };
    };
    assert.equal(shotResult.structuredContent.job.state, 'confirmed');
    assert.equal(shotResult.structuredContent.hasProofImage, true);
    const img = shotResult.content.find((c) => c.type === 'image');
    assert.equal(img?.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(img?.data ?? '', 'base64'), SAMPLE_PNG);

    const jobNoShot = await server.handleMessage({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: { name: 'aula_check_job', arguments: { jobId: 'delivery-job-1', includeScreenshot: false } },
    });
    assert.ok(jobNoShot && 'result' in jobNoShot);
    const noShotResult = jobNoShot.result as { content: Array<{ type: string }>; structuredContent: { hasProofImage: boolean } };
    assert.equal(noShotResult.structuredContent.hasProofImage, false);
    assert.equal(noShotResult.content.some((c) => c.type === 'image'), false);

    const createNoteRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'aula_create_note',
        arguments: {
          title: 'Revisar laboratorio 4',
          description: 'Llevar capturas',
          priority: 'alta',
          deadline: '2099-12-05',
        },
      },
    });
    assert.ok(createNoteRes && 'result' in createNoteRes);
    const created = (createNoteRes.result as { structuredContent: { note: { noteId: string; title: string; priority: string } } }).structuredContent;
    assert.equal(created.note.title, 'Revisar laboratorio 4');
    assert.equal(created.note.priority, 'alta');

    const listNotesRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: { name: 'aula_list_notes', arguments: {} },
    });
    assert.ok(listNotesRes && 'result' in listNotesRes);
    const notesList = (listNotesRes.result as { structuredContent: { notes: Array<{ title: string }> } }).structuredContent.notes;
    assert.equal(notesList.length, 2);
  } finally {
    await stub.close();
  }
});

test('serveStdio emits only valid JSON-RPC lines and skips notifications', async () => {
  const stub = await startStubPanel();
  try {
    const client = new AulaPanelClient(stub.baseUrl);
    const server = new AulaMcpServer(client);
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    let captured = '';
    stdout.on('data', (chunk) => {
      captured += chunk.toString('utf8');
    });

    const serving = serveStdio(server, stdin, stdout);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    stdin.end();
    await serving;

    const lines = captured.trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!) as { id: number; result: { serverInfo: { name: string } } };
    const second = JSON.parse(lines[1]!) as { id: number; result: Record<string, unknown> };
    assert.equal(first.id, 1);
    assert.equal(first.result.serverInfo.name, 'aula-virtual-unsa');
    assert.equal(second.id, 2);
    assert.deepEqual(second.result, {});
  } finally {
    await stub.close();
  }
});

test('agent CLI supports status, deliver with --wait and --proof-out, and notes create', async () => {
  const stub = await startStubPanel();
  stub.state.policy = 'direct_on_exact_match';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aula-cli-'));
  try {
    const pdfPath = path.join(dir, 'tareaMN.pdf');
    const proofOut = path.join(dir, 'comprobante.png');
    await writeFile(pdfPath, SAMPLE_PDF);

    const out: string[] = [];
    const err: string[] = [];
    const code = await runAgentCli(
      ['deliver', '--file', pdfPath, '--instruction', 'subelo a la tarea 3 de mn', '--wait', '--proof-out', proofOut],
      {
        baseUrl: stub.baseUrl,
        waitOptions: { pollMs: 10, timeoutMs: 2000 },
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
    );

    assert.equal(code, 0, `Unexpected stderr: ${err.join('\n')}`);
    assert.equal(err.length, 0);
    const parsed = JSON.parse(out.join('\n')) as { outcome: string; job?: { state: string }; proofSavedTo?: string };
    assert.equal(parsed.outcome, 'authorized');
    assert.equal(parsed.job?.state, 'confirmed');
    assert.equal(parsed.proofSavedTo, proofOut);
    assert.deepEqual(await readFile(proofOut), SAMPLE_PNG);

    const badErr: string[] = [];
    const badCode = await runAgentCli(['unknown-cmd'], {
      baseUrl: stub.baseUrl,
      stdout: () => {},
      stderr: (line) => badErr.push(line),
    });
    assert.equal(badCode, 1);
    assert.ok(badErr.join('\n').length > 0);

    // Exercise status, tasks --query, sync --wait, job --proof-out, notes list & notes create.
    const statusOut: string[] = [];
    assert.equal(await runAgentCli(['status'], { baseUrl: stub.baseUrl, stdout: (l) => statusOut.push(l), stderr: () => {} }), 0);
    assert.equal(JSON.parse(statusOut.join('\n')).accountId, 'acc-local-1');

    const tasksOut: string[] = [];
    assert.equal(await runAgentCli(['tasks', '--query', 'tarea 3 de mn'], { baseUrl: stub.baseUrl, stdout: (l) => tasksOut.push(l), stderr: () => {} }), 0);
    assert.equal(JSON.parse(tasksOut.join('\n')).match.kind, 'exact');

    const syncOut: string[] = [];
    assert.equal(await runAgentCli(['sync', '--wait'], {
      baseUrl: stub.baseUrl,
      waitOptions: { pollMs: 10, timeoutMs: 2000 },
      stdout: (l) => syncOut.push(l),
      stderr: () => {},
    }), 0);
    assert.equal(JSON.parse(syncOut.join('\n')).job.state, 'completed');

    const jobProofOut = path.join(dir, 'job-proof.png');
    const jobOut: string[] = [];
    assert.equal(await runAgentCli(['job', 'delivery-job-1', '--proof-out', jobProofOut], {
      baseUrl: stub.baseUrl,
      stdout: (l) => jobOut.push(l),
      stderr: () => {},
    }), 0);
    assert.deepEqual(await readFile(jobProofOut), SAMPLE_PNG);

    const createOut: string[] = [];
    assert.equal(await runAgentCli(
      ['notes', 'create', '--title', 'Nota CLI', '--priority', 'media', '--description', 'Detalle', '--deadline', '2099-12-10'],
      { baseUrl: stub.baseUrl, stdout: (l) => createOut.push(l), stderr: () => {} },
    ), 0);
    assert.equal(JSON.parse(createOut.join('\n')).note.title, 'Nota CLI');

    const notesOut: string[] = [];
    assert.equal(await runAgentCli(['notes', 'list'], { baseUrl: stub.baseUrl, stdout: (l) => notesOut.push(l), stderr: () => {} }), 0);
    assert.equal(JSON.parse(notesOut.join('\n')).notes.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('client handles analyzeInstruction, authorizeProposal, 404 proof, and invalid PNG rejection', async () => {
  const stub = await startStubPanel();
  try {
    const client = new AulaPanelClient(stub.baseUrl);
    const analyzed = await client.analyzeInstruction('subelo a la tarea 3 de mn');
    assert.equal(analyzed.kind, 'exact');
    assert.equal(analyzed.match?.task.taskId, TASK_MN.taskId);

    const authorized = await client.authorizeProposal('prop-1111');
    assert.equal(authorized.jobId, 'delivery-job-1');
    assert.equal(authorized.proposal.state, 'authorized');

    assert.equal(await client.fetchProofPng('no-proof'), null);
    await assert.rejects(() => client.fetchProofPng('bad-png'), /PNG/i);
  } finally {
    await stub.close();
  }
});

test('MCP server handles no_match, waitForResult=false, tool isError, and JSON-RPC error codes', async () => {
  const stub = await startStubPanel();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-err-'));
  try {
    const pdfPath = path.join(dir, 'tareaMN.pdf');
    await writeFile(pdfPath, SAMPLE_PDF);

    const client = new AulaPanelClient(stub.baseUrl);
    const server = new AulaMcpServer(client, { waitOptions: { pollMs: 10, timeoutMs: 2000 } });

    const parseErr = await server.handleMessage('{not valid json');
    assert.ok(parseErr && 'error' in parseErr);
    assert.equal(parseErr.error.code, -32700);

    const unknownMethod = await server.handleMessage({ jsonrpc: '2.0', id: 40, method: 'resources/unknown' });
    assert.ok(unknownMethod && 'error' in unknownMethod);
    assert.equal(unknownMethod.error.code, -32601);

    const unknownTool = await server.handleMessage({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'aula_nonexistent', arguments: {} },
    });
    assert.ok(unknownTool && 'error' in unknownTool);
    assert.equal(unknownTool.error.code, -32602);

    const missingFileRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: { filePath: path.join(dir, 'missing.pdf'), instruction: 'sube tarea 3 de mn' },
      },
    });
    assert.ok(missingFileRes && 'result' in missingFileRes);
    assert.equal((missingFileRes.result as { isError?: boolean }).isError, true);

    stub.state.deliverOutcomeOverride = 'no_match';
    const noMatchRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 43,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: { filePath: pdfPath, instruction: 'sube a curso inexistente' },
      },
    });
    assert.ok(noMatchRes && 'result' in noMatchRes);
    assert.equal((noMatchRes.result as { structuredContent: { outcome: string } }).structuredContent.outcome, 'no_match');

    stub.state.deliverOutcomeOverride = undefined;
    stub.state.policy = 'direct_on_exact_match';
    const noWaitRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 44,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: { filePath: pdfPath, instruction: 'sube tarea 3 de mn', waitForResult: false },
      },
    });
    assert.ok(noWaitRes && 'result' in noWaitRes);
    const noWaitPayload = noWaitRes.result as { structuredContent: { outcome: string; jobId: string; waited: boolean } };
    assert.equal(noWaitPayload.structuredContent.outcome, 'authorized');
    assert.equal(noWaitPayload.structuredContent.jobId, 'delivery-job-1');
    assert.equal(noWaitPayload.structuredContent.waited, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test('stdio entrypoint runs as child process emitting strictly JSON-RPC lines to stdout', async () => {
  const stub = await startStubPanel();
  try {
    const stdioScript = path.join(__dirname, 'stdio.js');
    const child = spawn(process.execPath, [stdioScript], {
      env: { ...process.env, AULA_PANEL_URL: stub.baseUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutData = '';
    let stderrData = '';
    child.stdout.on('data', (chunk: Buffer) => { stdoutData += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderrData += chunk.toString('utf8'); });

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aula_status', arguments: {} } }) + '\n');
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    assert.equal(exitCode, 0, `Unexpected stderr: ${stderrData}`);
    assert.equal(stderrData, '');
    const lines = stdoutData.trim().split('\n');
    assert.equal(lines.length, 2);
    const initLine = JSON.parse(lines[0]!) as { id: number; result: { serverInfo: { name: string } } };
    const statusLine = JSON.parse(lines[1]!) as { id: number; result: { structuredContent: { accountId: string } } };
    assert.equal(initLine.result.serverInfo.name, 'aula-virtual-unsa');
    assert.equal(statusLine.result.structuredContent.accountId, 'acc-local-1');
  } finally {
    await stub.close();
  }
});

test('resolveLocalPanelUrl auto-discovers .runtime-panel-url and .env APP_PORT while rejecting non-loopback runtime URLs', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-ws-'));
  try {
    // 1. Default fallback when nothing is configured.
    assert.equal(
      resolveLocalPanelUrl(undefined, { workspaceDir, env: {} }),
      'http://127.0.0.1:3000',
    );

    // 2. Reads APP_PORT from .env file.
    await writeFile(path.join(workspaceDir, '.env'), '# comment\nAPP_PORT=3145\n');
    assert.equal(
      resolveLocalPanelUrl(undefined, { workspaceDir, env: {} }),
      'http://127.0.0.1:3145',
    );

    // 3. env.APP_PORT takes precedence over .env APP_PORT.
    assert.equal(
      resolveLocalPanelUrl(undefined, { workspaceDir, env: { APP_PORT: '3250' } }),
      'http://127.0.0.1:3250',
    );

    // 4. .runtime-panel-url takes precedence over APP_PORT / .env.
    await writeFile(path.join(workspaceDir, '.runtime-panel-url'), 'http://127.0.0.1:3401/\n');
    assert.equal(
      resolveLocalPanelUrl(undefined, { workspaceDir, env: { APP_PORT: '3250' } }),
      'http://127.0.0.1:3401',
    );

    // 5. env.AULA_PANEL_URL takes precedence over .runtime-panel-url.
    assert.equal(
      resolveLocalPanelUrl(undefined, {
        workspaceDir,
        env: { AULA_PANEL_URL: 'http://localhost:3500', APP_PORT: '3250' },
      }),
      'http://localhost:3500',
    );

    // 6. Rejects non-loopback or non-HTTP URLs inside .runtime-panel-url.
    await writeFile(path.join(workspaceDir, '.runtime-panel-url'), 'http://192.168.1.50:3000\n');
    assert.throws(
      () => resolveLocalPanelUrl(undefined, { workspaceDir, env: {} }),
      /loopback|remoto|local/i,
    );

    await writeFile(path.join(workspaceDir, '.runtime-panel-url'), 'https://127.0.0.1:3000\n');
    assert.throws(
      () => resolveLocalPanelUrl(undefined, { workspaceDir, env: {} }),
      /http|protocolo/i,
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('resolveUserPath, readHostPdf, and findLocalPdfs support case-insensitive paths, skip symlinks/hidden dirs, and distinguish exact vs ambiguous PDFs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-find-'));
  try {
    const userDir = path.join(root, 'student');
    const mnDir = path.join(userDir, 'mn');
    const isDir = path.join(userDir, 'is');
    const hiddenDir = path.join(userDir, '.hidden');
    const gitDir = path.join(userDir, '.git');
    const nmDir = path.join(userDir, 'node_modules');
    const distDir = path.join(userDir, 'dist');
    const externalDir = path.join(root, 'outside');

    await Promise.all([
      mkdir(mnDir, { recursive: true }),
      mkdir(isDir, { recursive: true }),
      mkdir(hiddenDir, { recursive: true }),
      mkdir(gitDir, { recursive: true }),
      mkdir(nmDir, { recursive: true }),
      mkdir(distDir, { recursive: true }),
      mkdir(externalDir, { recursive: true }),
    ]);

    const mnLab8 = path.join(mnDir, 'Lab08.pdf');
    const mnLab7 = path.join(mnDir, 'Lab07.pdf');
    const isLab8 = path.join(isDir, 'Lab08.pdf');
    const outsidePdf = path.join(externalDir, 'SecretLab08.pdf');

    await Promise.all([
      writeFile(mnLab8, SAMPLE_PDF),
      writeFile(mnLab7, SAMPLE_PDF),
      writeFile(isLab8, SAMPLE_PDF),
      writeFile(path.join(hiddenDir, 'Lab08.pdf'), SAMPLE_PDF),
      writeFile(path.join(gitDir, 'Lab08.pdf'), SAMPLE_PDF),
      writeFile(path.join(nmDir, 'Lab08.pdf'), SAMPLE_PDF),
      writeFile(path.join(distDir, 'Lab08.pdf'), SAMPLE_PDF),
      writeFile(path.join(mnDir, 'tiny.pdf'), '%PDF-1\n%%EOF'),
      writeFile(path.join(mnDir, 'notes.txt'), 'not a pdf'),
      writeFile(outsidePdf, SAMPLE_PDF),
    ]);

    await symlink(outsidePdf, path.join(mnDir, 'Lab08_link.pdf'));
    await symlink(externalDir, path.join(userDir, 'linked_dir'));

    // Set deterministic mtimes to test unmodified listing sort order.
    await utimes(mnLab7, new Date('2026-11-20T10:00:00Z'), new Date('2026-11-20T10:00:00Z'));
    await utimes(isLab8, new Date('2026-11-22T10:00:00Z'), new Date('2026-11-22T10:00:00Z'));
    await utimes(mnLab8, new Date('2026-11-26T10:00:00Z'), new Date('2026-11-26T10:00:00Z'));

    // Case-insensitive directory & file resolution.
    const casedDir = path.join(root, 'Student');
    assert.equal(await resolveUserPath(casedDir), userDir);

    if (os.homedir().startsWith('/home/')) {
      const homeBase = path.basename(os.homedir());
      const flipped = `${homeBase[0] === homeBase[0]?.toUpperCase() ? homeBase[0]!.toLowerCase() : homeBase[0]!.toUpperCase()}${homeBase.slice(1)}`;
      assert.equal(await resolveUserPath(`home/${flipped}`), os.homedir());
    }

    const casedFile = path.join(root, 'Student', 'MN', 'lab08.pdf');
    const loaded = await readHostPdf(casedFile);
    assert.equal(loaded.resolvedPath, mnLab8);
    assert.equal(loaded.originalName, 'Lab08.pdf');

    // Listing without query returns valid PDFs sorted by modifiedAt desc, skipping symlinks/hidden/ignored dirs.
    const listed = await findLocalPdfs(casedDir);
    assert.equal(listed.resolvedDir, userDir);
    assert.deepEqual(
      listed.files.map((f) => f.relativePath),
      ['mn/Lab08.pdf', 'is/Lab08.pdf', 'mn/Lab07.pdf'],
    );

    // Exact query resolution.
    const exact = await findLocalPdfs(casedDir, 'subeme el laboratorio 8 de mn');
    assert.equal(exact.matchResult.kind, 'exact');
    assert.equal(exact.matchResult.match?.file.path, mnLab8);

    // Reject symlink root and non-directory paths.
    const rootLink = path.join(root, 'student-link');
    await symlink(userDir, rootLink);
    await assert.rejects(() => findLocalPdfs(rootLink), /enlace simbólico|symlink/i);
    await assert.rejects(() => findLocalPdfs(mnLab8), /directorio/i);

    // Ambiguous PDFs when two close files match (Lab07 excluded by wrong number; top 2 are MN Lab08 files).
    const mnLab8Copy = path.join(mnDir, 'Lab08_final.pdf');
    await writeFile(mnLab8Copy, SAMPLE_PDF);
    const ambiguous = await findLocalPdfs(casedDir, 'subeme el laboratorio 8 de mn');
    assert.equal(ambiguous.matchResult.kind, 'ambiguous');
    assert.equal(ambiguous.matchResult.match, null);
    assert.equal(ambiguous.matchResult.candidates.some((c) => c.file.relativePath === 'mn/Lab07.pdf'), false);
    assert.deepEqual(
      ambiguous.matchResult.candidates.slice(0, 2).map((c) => c.file.relativePath).sort(),
      ['mn/Lab08.pdf', 'mn/Lab08_final.pdf'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP aula_find_local_pdfs and directory-based aula_deliver_pdf handle exact confirmation with PNG and ambiguous refusal', async () => {
  const stub = await startStubPanel();
  stub.state.policy = 'direct_on_exact_match';
  const root = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-dir-deliv-'));
  try {
    const userDir = path.join(root, 'student');
    const mnDir = path.join(userDir, 'mn');
    const isDir = path.join(userDir, 'is');
    await mkdir(mnDir, { recursive: true });
    await mkdir(isDir, { recursive: true });

    const mnLab8 = path.join(mnDir, 'Lab08.pdf');
    await writeFile(mnLab8, SAMPLE_PDF);
    await writeFile(path.join(isDir, 'Lab08.pdf'), SAMPLE_PDF);

    const client = new AulaPanelClient(stub.baseUrl);
    const server = new AulaMcpServer(client, { waitOptions: { pollMs: 10, timeoutMs: 2000 } });
    const casedDir = path.join(root, 'Student');

    // 1. aula_find_local_pdfs returns exact match with resolved path.
    const findRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 60,
      method: 'tools/call',
      params: {
        name: 'aula_find_local_pdfs',
        arguments: { searchDir: casedDir, query: 'subeme el laboratorio 8 de mn' },
      },
    });
    assert.ok(findRes && 'result' in findRes);
    const findPayload = findRes.result as {
      isError?: boolean;
      structuredContent: {
        resolvedDir: string;
        kind: string;
        match: { file: { path: string; relativePath: string } } | null;
      };
    };
    assert.notEqual(findPayload.isError, true);
    assert.equal(findPayload.structuredContent.resolvedDir, userDir);
    assert.equal(findPayload.structuredContent.kind, 'exact');
    assert.equal(findPayload.structuredContent.match?.file.path, mnLab8);

    // 2. Directory-based aula_deliver_pdf resolves exact PDF, accepts custom source, confirms, and returns inline PNG.
    const deliverRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 61,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: {
          filePath: casedDir,
          instruction: 'subeme el laboratorio 8 de mn que esta en la ruta home/Student subelo al correspondiente',
          source: 'gemini',
        },
      },
    });
    assert.ok(deliverRes && 'result' in deliverRes);
    const deliverPayload = deliverRes.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      structuredContent: {
        outcome: string;
        jobId: string;
        job: { state: string };
        hasProofImage: boolean;
      };
    };
    assert.notEqual(deliverPayload.isError, true);
    assert.equal(deliverPayload.structuredContent.outcome, 'authorized');
    assert.equal(deliverPayload.structuredContent.job.state, 'confirmed');
    assert.equal(deliverPayload.structuredContent.hasProofImage, true);
    assert.equal(stub.state.uploads.length, 1);
    assert.equal(stub.state.uploads[0]?.fileName, 'Lab08.pdf');
    assert.equal(stub.state.uploads[0]?.source, 'gemini');
    const pngBlock = deliverPayload.content.find((b) => b.type === 'image');
    assert.equal(pngBlock?.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(pngBlock?.data ?? '', 'base64'), SAMPLE_PNG);

    // 3. Directory-based aula_deliver_pdf refuses ambiguous PDFs without uploading.
    await writeFile(path.join(mnDir, 'Lab08_v2.pdf'), SAMPLE_PDF);
    const ambigRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 62,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: {
          filePath: casedDir,
          instruction: 'subeme el laboratorio 8 de mn',
        },
      },
    });
    assert.ok(ambigRes && 'result' in ambigRes);
    const ambigPayload = ambigRes.result as {
      isError?: boolean;
      structuredContent: {
        outcome: string;
        candidates: Array<{ file: { relativePath: string } }>;
      };
    };
    assert.notEqual(ambigPayload.isError, true);
    assert.equal(ambigPayload.structuredContent.outcome, 'ambiguous_file');
    assert.ok(ambigPayload.structuredContent.candidates.length >= 2);
    assert.deepEqual(
      ambigPayload.structuredContent.candidates.slice(0, 2).map((c) => c.file.relativePath).sort(),
      ['mn/Lab08.pdf', 'mn/Lab08_v2.pdf'],
    );
    assert.equal(stub.state.uploads.length, 1, 'Must not upload when PDF selection is ambiguous');

    // 4. Directory-based aula_deliver_pdf returns isError when no PDF matches.
    const noFileRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 63,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: {
          filePath: casedDir,
          instruction: 'subeme el examen 99 de fisica cuantica',
        },
      },
    });
    assert.ok(noFileRes && 'result' in noFileRes);
    assert.equal((noFileRes.result as { isError?: boolean }).isError, true);
    assert.equal(stub.state.uploads.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await stub.close();
  }
});

test('agent CLI supports find --dir --query and directory-based deliver', async () => {
  const stub = await startStubPanel();
  stub.state.policy = 'direct_on_exact_match';
  const root = await mkdtemp(path.join(os.tmpdir(), 'aula-cli-find-'));
  try {
    const userDir = path.join(root, 'student');
    const mnDir = path.join(userDir, 'mn');
    await mkdir(mnDir, { recursive: true });
    const mnLab8 = path.join(mnDir, 'Lab08.pdf');
    await writeFile(mnLab8, SAMPLE_PDF);

    const casedDir = path.join(root, 'Student');
    const findOut: string[] = [];
    const findErr: string[] = [];
    const findCode = await runAgentCli(
      ['find', '--dir', casedDir, '--query', 'laboratorio 8 de mn', '--max-depth', '3'],
      {
        stdout: (line) => findOut.push(line),
        stderr: (line) => findErr.push(line),
      },
    );
    assert.equal(findCode, 0, `Unexpected stderr: ${findErr.join('\n')}`);
    const found = JSON.parse(findOut.join('\n')) as {
      resolvedDir: string;
      matchResult: { kind: string; match: { file: { path: string } } | null };
    };
    assert.equal(found.resolvedDir, userDir);
    assert.equal(found.matchResult.kind, 'exact');
    assert.equal(found.matchResult.match?.file.path, mnLab8);

    const delivOut: string[] = [];
    const delivErr: string[] = [];
    const delivCode = await runAgentCli(
      ['deliver', '--file', casedDir, '--instruction', 'subeme el laboratorio 8 de mn', '--wait'],
      {
        baseUrl: stub.baseUrl,
        waitOptions: { pollMs: 10, timeoutMs: 2000 },
        stdout: (line) => delivOut.push(line),
        stderr: (line) => delivErr.push(line),
      },
    );
    assert.equal(delivCode, 0, `Unexpected stderr: ${delivErr.join('\n')}`);
    const delivered = JSON.parse(delivOut.join('\n')) as { outcome: string; job?: { state: string } };
    assert.equal(delivered.outcome, 'authorized');
    assert.equal(delivered.job?.state, 'confirmed');
    assert.equal(stub.state.uploads.length, 1);
    assert.equal(stub.state.uploads[0]?.fileName, 'Lab08.pdf');

    // Ambiguous directory in CLI returns structured ambiguous_file without uploading.
    await writeFile(path.join(mnDir, 'Lab08_final.pdf'), SAMPLE_PDF);
    const ambigOut: string[] = [];
    const ambigCode = await runAgentCli(
      ['deliver', '--file', casedDir, '--instruction', 'subeme el laboratorio 8 de mn'],
      {
        baseUrl: stub.baseUrl,
        stdout: (line) => ambigOut.push(line),
        stderr: () => {},
      },
    );
    assert.equal(ambigCode, 0);
    assert.equal(JSON.parse(ambigOut.join('\n')).outcome, 'ambiguous_file');
    assert.equal(stub.state.uploads.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await stub.close();
  }
});

test('AulaPanelClient re-resolves .runtime-panel-url dynamically and findLocalPdfs skips hidden PDF files', async () => {
  const stubA = await startStubPanel();
  const stubB = await startStubPanel();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aula-dynamic-port-'));
  try {
    const runtimeFile = path.join(root, '.runtime-panel-url');
    await writeFile(runtimeFile, `${stubA.baseUrl}\n`, { mode: 0o600 });

    const client = new AulaPanelClient({ workspaceDir: root, env: {} });
    assert.equal(client.baseUrl, stubA.baseUrl);
    const statusA = await client.getStatus();
    assert.equal(statusA.policy, 'confirm_in_panel');

    // Simulate npm run up switching the panel to a new free port without restarting the MCP client.
    stubB.state.policy = 'direct_on_exact_match';
    await writeFile(runtimeFile, `${stubB.baseUrl}\n`, { mode: 0o600 });
    assert.equal(client.baseUrl, stubB.baseUrl);
    const statusB = await client.getStatus();
    assert.equal(statusB.policy, 'direct_on_exact_match');

    // Hidden PDF files (e.g. .draft.pdf) must be skipped by findLocalPdfs.
    const docsDir = path.join(root, 'mn');
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, '.Lab08_hidden.pdf'), SAMPLE_PDF);
    await writeFile(path.join(docsDir, 'Lab08.pdf'), SAMPLE_PDF);
    const found = await findLocalPdfs(root, 'laboratorio 8 de mn');
    assert.equal(found.matchResult.kind, 'exact');
    assert.equal(found.files.length, 1);
    assert.equal(found.files[0]?.fileName, 'Lab08.pdf');
  } finally {
    await rm(root, { recursive: true, force: true });
    await stubA.close();
    await stubB.close();
  }
});

test('parseBase64Pdf validates raw and data-URI PDFs, computes exact SHA-256, and rejects invalid inputs', () => {
  const rawBase64 = SAMPLE_PDF.toString('base64');
  const spacedBase64 = `${rawBase64.slice(0, 12)}\n  ${rawBase64.slice(12)}  `;

  const parsedRaw = parseBase64Pdf(spacedBase64, 'Lab08.pdf');
  assert.equal(parsedRaw.resolvedPath, 'inline://Lab08.pdf');
  assert.equal(parsedRaw.originalName, 'Lab08.pdf');
  assert.equal(parsedRaw.sizeBytes, SAMPLE_PDF.byteLength);
  assert.equal(parsedRaw.sha256, SAMPLE_PDF_SHA256);
  assert.deepEqual(parsedRaw.content, SAMPLE_PDF);

  const parsedDataUri = parseBase64Pdf(`data:application/pdf;base64,${rawBase64}`, 'Entrega_Final.PDF');
  assert.equal(parsedDataUri.resolvedPath, 'inline://Entrega_Final.PDF');
  assert.equal(parsedDataUri.originalName, 'Entrega_Final.PDF');
  assert.equal(parsedDataUri.sha256, SAMPLE_PDF_SHA256);

  // Larger valid PDF (~1 MiB) parses cleanly without regex stack overflow.
  const largePdf = Buffer.concat([
    Buffer.from('%PDF-1.7\n%', 'ascii'),
    Buffer.alloc(1024 * 1024, 0x41),
    Buffer.from('\n%%EOF\n', 'ascii'),
  ]);
  const parsedLarge = parseBase64Pdf(largePdf.toString('base64'), 'Large_Lab08.pdf');
  assert.equal(parsedLarge.sizeBytes, largePdf.byteLength);
  assert.equal(parsedLarge.sha256, createHash('sha256').update(largePdf).digest('hex'));

  // Reject non-PDF content and truncated PDFs.
  assert.throws(
    () => parseBase64Pdf(Buffer.from('plain text not a pdf file at all').toString('base64'), 'fake.pdf'),
    (err: unknown) => err instanceof AulaPanelError && err.code === 'invalid_pdf',
  );
  assert.throws(
    () => parseBase64Pdf(Buffer.from('%PDF-1.4\nmissing eof marker').toString('base64'), 'truncated.pdf'),
    (err: unknown) => err instanceof AulaPanelError && err.code === 'invalid_pdf',
  );

  // Reject undersized (< 14 bytes) and oversized (> 20 MiB) payloads.
  assert.throws(
    () => parseBase64Pdf(Buffer.from('%PDF-1\n%%EOF').toString('base64'), 'tiny.pdf'),
    (err: unknown) => err instanceof AulaPanelError && err.code === 'invalid_pdf',
  );
  const oversizedBase64 = 'A'.repeat(28 * 1024 * 1024); // ~21 MiB decoded (> 20 MiB)
  assert.throws(
    () => parseBase64Pdf(oversizedBase64, 'huge.pdf'),
    (err: unknown) => err instanceof AulaPanelError && err.code === 'invalid_pdf',
  );

  // Reject invalid filenames (traversal, slashes, wrong extension, control chars, too long).
  for (const badName of [
    '',
    '   ',
    '../x.pdf',
    'sub/Lab08.pdf',
    'sub\\Lab08.pdf',
    'a..b.pdf',
    'Lab08.txt',
    '.pdf',
    'Lab08\n.pdf',
    'Lab08\x00.pdf',
    `${'a'.repeat(252)}.pdf`,
  ]) {
    assert.throws(
      () => parseBase64Pdf(rawBase64, badName),
      (err: unknown) => err instanceof AulaPanelError && err.code === 'invalid_pdf',
      `Expected rejection for fileName=${JSON.stringify(badName)}`,
    );
  }

  // Reject malformed base64 and non-PDF data URIs.
  for (const badBase64 of [
    '',
    '   ',
    'data:application/pdf;base64,',
    `data:text/plain;base64,${rawBase64}`,
    'not!valid@base64==',
    'abc',
    'ab=c',
  ]) {
    assert.throws(
      () => parseBase64Pdf(badBase64, 'Lab08.pdf'),
      (err: unknown) => err instanceof AulaPanelError && err.code === 'invalid_pdf',
      `Expected rejection for malformed base64=${JSON.stringify(badBase64)}`,
    );
  }
});

test('sandboxed resolveUserPath, findLocalPdfs, readHostPdf, and resolveDeliveryPdfTarget enforce sandbox jail strictly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-sandbox-'));
  try {
    const sandboxDir = path.join(root, 'inbox');
    const mnDir = path.join(sandboxDir, 'mn');
    const outsideDir = path.join(root, 'outside');
    await Promise.all([
      mkdir(mnDir, { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
    ]);

    const lab8 = path.join(mnDir, 'Lab08.pdf');
    const secretPdf = path.join(outsideDir, 'secret.pdf');
    await Promise.all([
      writeFile(lab8, SAMPLE_PDF),
      writeFile(secretPdf, SAMPLE_PDF),
    ]);

    // Symlinks escaping sandbox and internal symlink.
    await symlink(secretPdf, path.join(sandboxDir, 'escape_file.pdf'));
    await symlink(outsideDir, path.join(sandboxDir, 'escape_dir'));
    await symlink(lab8, path.join(sandboxDir, 'internal_link.pdf'));

    const realSandbox = await resolveUserPath('', sandboxDir);
    assert.equal(await resolveUserPath('.', sandboxDir), realSandbox);
    assert.equal(await resolveUserPath('/', sandboxDir), realSandbox);
    assert.equal(await resolveUserPath('/inbox', sandboxDir), realSandbox);
    assert.equal(await resolveUserPath(sandboxDir, sandboxDir), realSandbox);

    // Relative and case-insensitive paths inside sandbox resolve cleanly.
    const resolvedRelative = await resolveUserPath('mn/Lab08.pdf', sandboxDir);
    const resolvedCased = await resolveUserPath('MN/lab08.pdf', sandboxDir);
    assert.equal(resolvedRelative, resolvedCased);
    assert.equal(await resolveUserPath('/inbox/MN/lab08.pdf', sandboxDir), resolvedRelative);

    // findLocalPdfs skips symlinks and discovers valid PDFs inside sandbox.
    const found = await findLocalPdfs('', 'laboratorio 8 de mn', { sandboxRoot: sandboxDir });
    assert.equal(found.resolvedDir, realSandbox);
    assert.equal(found.matchResult.kind, 'exact');
    assert.equal(found.matchResult.match?.file.relativePath, 'mn/Lab08.pdf');
    assert.equal(found.files.some((f) => f.fileName.includes('escape') || f.fileName.includes('internal')), false);

    // resolveDeliveryPdfTarget works on '.' directory and case-insensitive file inside sandbox.
    const fromDir = await resolveDeliveryPdfTarget('.', 'subeme el laboratorio 8 de mn', sandboxDir);
    assert.equal(fromDir.kind, 'file');
    assert.equal(fromDir.pdf.originalName, 'Lab08.pdf');
    assert.equal(fromDir.pdf.sha256, SAMPLE_PDF_SHA256);

    const fromFile = await resolveDeliveryPdfTarget('MN/lab08.pdf', 'laboratorio 8 de mn', { sandboxRoot: sandboxDir });
    assert.equal(fromFile.kind, 'file');
    assert.equal(fromFile.pdf.originalName, 'Lab08.pdf');

    // Missing sandbox directory fails cleanly with sandbox_unavailable.
    await assert.rejects(
      () => resolveUserPath('.', path.join(root, 'missing-inbox')),
      (err: unknown) => err instanceof AulaPanelError && err.code === 'sandbox_unavailable',
    );

    // Reject path traversal, home expansion, absolute paths outside sandbox, and escaping symlinks.
    const escapePaths = [
      '../outside/secret.pdf',
      '../secret.pdf',
      'mn/../../outside/secret.pdf',
      '/inbox/../outside/secret.pdf',
      '..\\outside\\secret.pdf',
      '/etc/passwd',
      secretPdf,
      '~',
      '~/secret.pdf',
      'escape_file.pdf',
      'ESCAPE_FILE.PDF',
      'escape_dir',
      'escape_dir/secret.pdf',
      'ESCAPE_DIR/secret.pdf',
    ];
    for (const badPath of escapePaths) {
      await assert.rejects(
        () => resolveUserPath(badPath, sandboxDir),
        (err: unknown) => err instanceof AulaPanelError && err.code === 'outside_sandbox',
        `Expected outside_sandbox rejection for ${badPath}`,
      );
      await assert.rejects(
        () => resolveDeliveryPdfTarget(badPath, 'subeme el laboratorio 8', sandboxDir),
        (err: unknown) => err instanceof AulaPanelError && err.code === 'outside_sandbox',
        `Expected resolveDeliveryPdfTarget outside_sandbox rejection for ${badPath}`,
      );
    }

    await assert.rejects(
      () => findLocalPdfs('../outside', undefined, { sandboxRoot: sandboxDir }),
      (err: unknown) => err instanceof AulaPanelError && err.code === 'outside_sandbox',
    );
    await assert.rejects(
      () => findLocalPdfs('/etc', undefined, { sandboxRoot: sandboxDir }),
      (err: unknown) => err instanceof AulaPanelError && err.code === 'outside_sandbox',
    );
    await assert.rejects(
      () => findLocalPdfs('escape_dir', undefined, { sandboxRoot: sandboxDir }),
      (err: unknown) => err instanceof AulaPanelError && err.code === 'outside_sandbox',
    );
    await assert.rejects(
      () => readHostPdf('internal_link.pdf', sandboxDir),
      (err: unknown) => err instanceof AulaPanelError && err.code === 'symlink_rejected',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AulaMcpServer supports pdfBase64, sandboxInboxDir defaults/jail, publicBaseUrl rewriting, and aula_discard_delivery', async () => {
  const stub = await startStubPanel();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-srv-sandbox-'));
  try {
    const sandboxDir = path.join(root, 'inbox');
    const mnDir = path.join(sandboxDir, 'mn');
    const outsideDir = path.join(root, 'outside');
    await Promise.all([
      mkdir(mnDir, { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
    ]);
    await writeFile(path.join(mnDir, 'Lab08.pdf'), SAMPLE_PDF);
    await writeFile(path.join(outsideDir, 'secret.pdf'), SAMPLE_PDF);
    await symlink(path.join(outsideDir, 'secret.pdf'), path.join(sandboxDir, 'escape.pdf'));

    const client = new AulaPanelClient(stub.baseUrl);
    const server = new AulaMcpServer(client, {
      waitOptions: { pollMs: 10, timeoutMs: 2000 },
      sandboxInboxDir: sandboxDir,
      publicBaseUrl: 'http://127.0.0.1:3099',
    });

    // 1. aula_find_local_pdfs with omitted searchDir defaults to sandbox inbox.
    const findDefaultRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 70,
      method: 'tools/call',
      params: { name: 'aula_find_local_pdfs', arguments: { query: 'laboratorio 8 de mn' } },
    });
    assert.ok(findDefaultRes && 'result' in findDefaultRes);
    const findPayload = findDefaultRes.result as {
      isError?: boolean;
      structuredContent: { kind: string; match: { file: { relativePath: string } } | null };
    };
    assert.notEqual(findPayload.isError, true);
    assert.equal(findPayload.structuredContent.kind, 'exact');
    assert.equal(findPayload.structuredContent.match?.file.relativePath, 'mn/Lab08.pdf');

    // 2. aula_deliver_pdf via pdfBase64 + fileName under confirm_in_panel rewrites panelUrl to publicBaseUrl.
    const base64ConfirmRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 71,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: {
          pdfBase64: SAMPLE_PDF.toString('base64'),
          fileName: 'Lab08_inline.pdf',
          instruction: 'sube este pdf a la tarea 3 de mn',
        },
      },
    });
    assert.ok(base64ConfirmRes && 'result' in base64ConfirmRes);
    const confirmPayload = base64ConfirmRes.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
      structuredContent: { outcome: string; panelUrl: string; resolvedFilePath: string };
    };
    assert.notEqual(confirmPayload.isError, true);
    assert.equal(confirmPayload.structuredContent.outcome, 'pending_confirmation');
    assert.equal(confirmPayload.structuredContent.panelUrl, 'http://127.0.0.1:3099/agente');
    assert.equal(confirmPayload.structuredContent.resolvedFilePath, 'inline://Lab08_inline.pdf');
    assert.match(confirmPayload.content[0]?.text ?? '', /http:\/\/127\.0\.0\.1:3099\/agente/);
    assert.equal(stub.state.uploads.length, 1);
    assert.equal(stub.state.uploads[0]?.fileName, 'Lab08_inline.pdf');
    assert.deepEqual(stub.state.uploads[0]?.fileBytes, SAMPLE_PDF);

    // 3. aula_deliver_pdf via data-URI pdfBase64 under direct_on_exact_match returns inline PNG proof.
    stub.state.policy = 'direct_on_exact_match';
    const base64DirectRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 72,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: {
          pdfBase64: `data:application/pdf;base64,${SAMPLE_PDF.toString('base64')}`,
          fileName: 'Lab08_direct.pdf',
          instruction: 'sube este pdf a la tarea 3 de mn',
        },
      },
    });
    assert.ok(base64DirectRes && 'result' in base64DirectRes);
    const directPayload = base64DirectRes.result as {
      isError?: boolean;
      content: Array<{ type: string; mimeType?: string; data?: string }>;
      structuredContent: { outcome: string; job: { state: string }; hasProofImage: boolean };
    };
    assert.notEqual(directPayload.isError, true);
    assert.equal(directPayload.structuredContent.outcome, 'authorized');
    assert.equal(directPayload.structuredContent.job.state, 'confirmed');
    assert.equal(directPayload.structuredContent.hasProofImage, true);
    const pngBlock = directPayload.content.find((b) => b.type === 'image');
    assert.equal(pngBlock?.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(pngBlock?.data ?? '', 'base64'), SAMPLE_PNG);

    // 4. aula_deliver_pdf via sandboxed filePath works inside sandbox and blocks escaping sandbox.
    const sandboxFileRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 73,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: {
          filePath: 'MN/lab08.pdf',
          instruction: 'sube el laboratorio 8 de mn',
          waitForResult: false,
        },
      },
    });
    assert.ok(sandboxFileRes && 'result' in sandboxFileRes);
    assert.notEqual((sandboxFileRes.result as { isError?: boolean }).isError, true);
    assert.equal(stub.state.uploads.at(-1)?.fileName, 'Lab08.pdf');

    for (const escapeArg of ['../outside/secret.pdf', '/etc/passwd', 'escape.pdf']) {
      const escapedRes = await server.handleMessage({
        jsonrpc: '2.0',
        id: 74,
        method: 'tools/call',
        params: {
          name: 'aula_deliver_pdf',
          arguments: { filePath: escapeArg, instruction: 'sube tarea 3 de mn' },
        },
      });
      assert.ok(escapedRes && 'result' in escapedRes);
      const escapedPayload = escapedRes.result as { isError?: boolean; content: Array<{ text?: string }> };
      assert.equal(escapedPayload.isError, true, `Expected error for escape path ${escapeArg}`);
      assert.match(escapedPayload.content[0]?.text ?? '', /sandbox/i);
    }

    // 5. Rejects passing both filePath and pdfBase64, passing neither, or missing fileName.
    for (const badArgs of [
      { instruction: 'sube tarea 3 de mn' },
      { pdfBase64: SAMPLE_PDF.toString('base64'), instruction: 'sube tarea 3 de mn' },
      { fileName: 'Lab08.pdf', instruction: 'sube tarea 3 de mn' },
      {
        filePath: 'mn/Lab08.pdf',
        pdfBase64: SAMPLE_PDF.toString('base64'),
        fileName: 'Lab08.pdf',
        instruction: 'sube tarea 3 de mn',
      },
    ]) {
      const badRes = await server.handleMessage({
        jsonrpc: '2.0',
        id: 75,
        method: 'tools/call',
        params: { name: 'aula_deliver_pdf', arguments: badArgs },
      });
      assert.ok(badRes && 'result' in badRes);
      assert.equal((badRes.result as { isError?: boolean }).isError, true);
    }

    // 6. aula_discard_delivery calls DELETE /api/agente/tareas/:taskId/entregas/:jobId.
    const discardRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 76,
      method: 'tools/call',
      params: {
        name: 'aula_discard_delivery',
        arguments: { taskId: TASK_MN.taskId, jobId: 'failed-job-9' },
      },
    });
    assert.ok(discardRes && 'result' in discardRes);
    const discardPayload = discardRes.result as {
      isError?: boolean;
      content: Array<{ text?: string }>;
      structuredContent: { taskId: string; jobId: string; discarded: boolean };
    };
    assert.notEqual(discardPayload.isError, true);
    assert.equal(discardPayload.structuredContent.taskId, TASK_MN.taskId);
    assert.equal(discardPayload.structuredContent.jobId, 'failed-job-9');
    assert.equal(discardPayload.structuredContent.discarded, true);
    assert.match(discardPayload.content[0]?.text ?? '', /reintentar/i);
    assert.deepEqual(stub.state.discardedDeliveries, [{ taskId: TASK_MN.taskId, jobId: 'failed-job-9' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await stub.close();
  }
});

test('McpHttpController handles Streamable HTTP POST /mcp (200/202/400), publicBaseUrl, sandbox, and 405 on GET/DELETE', async () => {
  const stub = await startStubPanel();
  const stubPort = Number(new URL(stub.baseUrl).port);
  const root = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-http-'));
  const prevInbox = process.env.MCP_INBOX_DIR;
  const prevPublicUrl = process.env.APP_PUBLIC_URL;

  const createMockRes = () => {
    const headers = new Map<string, string>();
    let statusCode = 200;
    let jsonBody: unknown;
    let ended = false;
    const res = {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(payload: unknown) {
        jsonBody = payload;
        ended = true;
        return res;
      },
      end() {
        ended = true;
        return res;
      },
    };
    return {
      res: res as unknown as Response,
      get statusCode() { return statusCode; },
      get headers() { return headers; },
      get jsonBody() { return jsonBody; },
      get ended() { return ended; },
    };
  };

  const createMockReq = (host: string): Request => ({
    socket: { localPort: stubPort },
    get(header: string) {
      return header.toLowerCase() === 'host' ? host : undefined;
    },
  } as unknown as Request);

  try {
    await writeFile(path.join(root, 'Lab08.pdf'), SAMPLE_PDF);
    process.env.MCP_INBOX_DIR = root;
    process.env.APP_PUBLIC_URL = 'http://127.0.0.1:3042';

    const controller = new McpHttpController();

    // 1. initialize returns 200 with protocol header and Cache-Control: no-store.
    const initRes = createMockRes();
    await controller.handlePost(
      createMockReq('127.0.0.1:3042'),
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      initRes.res,
    );
    assert.equal(initRes.statusCode, 200);
    assert.equal(initRes.headers.get('mcp-protocol-version'), '2025-06-18');
    assert.equal(initRes.headers.get('cache-control'), 'no-store');
    assert.equal((initRes.jsonBody as { result: { serverInfo: { name: string } } }).result.serverInfo.name, 'aula-virtual-unsa');

    // 2. Notification returns 202 with empty body.
    const notifRes = createMockRes();
    await controller.handlePost(
      createMockReq('127.0.0.1:3042'),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      notifRes.res,
    );
    assert.equal(notifRes.statusCode, 202);
    assert.equal(notifRes.ended, true);
    assert.equal(notifRes.jsonBody, undefined);
    assert.equal(notifRes.headers.get('mcp-protocol-version'), '2025-06-18');

    // 3. Malformed / batch / empty JSON-RPC payloads return HTTP 400 with -32600.
    for (const badBody of [[], 'bad', null, {}]) {
      const badRes = createMockRes();
      await controller.handlePost(createMockReq('127.0.0.1:3042'), badBody, badRes.res);
      assert.equal(badRes.statusCode, 400);
      assert.equal((badRes.jsonBody as { error: { code: number } }).error.code, -32600);
    }

    // 4. tools/call aula_deliver_pdf via pdfBase64 uses internal port and rewrites panelUrl via APP_PUBLIC_URL.
    const deliverRes = createMockRes();
    await controller.handlePost(
      createMockReq('127.0.0.1:3042'),
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'aula_deliver_pdf',
          arguments: {
            pdfBase64: SAMPLE_PDF.toString('base64'),
            fileName: 'Lab08.pdf',
            instruction: 'sube a la tarea 3 de mn',
          },
        },
      },
      deliverRes.res,
    );
    assert.equal(deliverRes.statusCode, 200);
    const deliverPayload = (deliverRes.jsonBody as { result: { structuredContent: { panelUrl: string } } }).result;
    assert.equal(deliverPayload.structuredContent.panelUrl, 'http://127.0.0.1:3042/agente');

    // 5. Without APP_PUBLIC_URL, falls back to validated loopback Host header.
    delete process.env.APP_PUBLIC_URL;
    const hostFallbackRes = createMockRes();
    await controller.handlePost(
      createMockReq('localhost:3055'),
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'aula_deliver_pdf',
          arguments: {
            filePath: 'Lab08.pdf',
            instruction: 'sube a la tarea 3 de mn',
          },
        },
      },
      hostFallbackRes.res,
    );
    assert.equal(hostFallbackRes.statusCode, 200);
    const fallbackPayload = (hostFallbackRes.jsonBody as { result: { structuredContent: { panelUrl: string } } }).result;
    assert.equal(fallbackPayload.structuredContent.panelUrl, 'http://localhost:3055/agente');

    // 6. GET and DELETE return 405 with Allow: POST.
    const getRes = createMockRes();
    controller.handleGet(getRes.res);
    assert.equal(getRes.statusCode, 405);
    assert.equal(getRes.headers.get('allow'), 'POST');
    assert.deepEqual(getRes.jsonBody, {
      error: 'Este servidor MCP usa Streamable HTTP stateless sobre POST /mcp.',
    });

    const deleteRes = createMockRes();
    controller.handleDelete(deleteRes.res);
    assert.equal(deleteRes.statusCode, 405);
    assert.equal(deleteRes.headers.get('allow'), 'POST');
    assert.deepEqual(deleteRes.jsonBody, {
      error: 'Este servidor MCP usa Streamable HTTP stateless sobre POST /mcp.',
    });
  } finally {
    if (prevInbox === undefined) delete process.env.MCP_INBOX_DIR;
    else process.env.MCP_INBOX_DIR = prevInbox;
    if (prevPublicUrl === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = prevPublicUrl;
    await rm(root, { recursive: true, force: true });
    await stub.close();
  }
});

test('stdio entrypoint uses PORT and MCP_INBOX_DIR sandbox with APP_PUBLIC_URL when AULA_PANEL_URL is unset', async () => {
  const stub = await startStubPanel();
  const stubPort = new URL(stub.baseUrl).port;
  const inboxDir = await mkdtemp(path.join(os.tmpdir(), 'aula-mcp-stdio-sandbox-'));
  try {
    await writeFile(path.join(inboxDir, 'Lab08.pdf'), SAMPLE_PDF);
    const stdioScript = path.join(__dirname, 'stdio.js');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: stubPort,
      MCP_INBOX_DIR: inboxDir,
      APP_PUBLIC_URL: 'http://127.0.0.1:3088',
    };
    delete env.AULA_PANEL_URL;

    const child = spawn(process.execPath, [stdioScript], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutData = '';
    let stderrData = '';
    child.stdout.on('data', (chunk: Buffer) => { stdoutData += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderrData += chunk.toString('utf8'); });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'aula_find_local_pdfs', arguments: {} },
    }) + '\n');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: { filePath: 'Lab08.pdf', instruction: 'sube a la tarea 3 de mn' },
      },
    }) + '\n');
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    assert.equal(exitCode, 0, `Unexpected stderr: ${stderrData}`);
    assert.equal(stderrData, '');
    const lines = stdoutData.trim().split('\n');
    assert.equal(lines.length, 2);

    const findLine = JSON.parse(lines[0]!) as {
      result: { structuredContent: { files: Array<{ fileName: string }> } };
    };
    assert.equal(findLine.result.structuredContent.files[0]?.fileName, 'Lab08.pdf');

    const deliverLine = JSON.parse(lines[1]!) as {
      result: { structuredContent: { outcome: string; panelUrl: string } };
    };
    assert.equal(deliverLine.result.structuredContent.outcome, 'pending_confirmation');
    assert.equal(deliverLine.result.structuredContent.panelUrl, 'http://127.0.0.1:3088/agente');
  } finally {
    await rm(inboxDir, { recursive: true, force: true });
    await stub.close();
  }
});
