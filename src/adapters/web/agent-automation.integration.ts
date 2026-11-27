import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createApplication } from '../../bootstrap/application';
import { AulaPanelClient } from '../mcp/client';
import { AulaMcpServer } from '../mcp/server';
import { LocalProofStore } from '../persistence/files';
import {
  postgresDatabase,
  PostgresAssignmentImportRepository,
  PostgresWorkerRepository,
} from '../persistence/repositories';
import { presentProposal } from './panel.presenter';

// Minimal valid 1x1 PNG image bytes.
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const SAMPLE_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');

async function openEvents(origin: string) {
  const controller = new AbortController();
  const response = await fetch(origin + '/eventos/tareas', {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
  });
  assert.equal(response.status, 200);
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

test('full harness MCP + web panel automation flow: proposals, SSE, proof PNG, Completadas drop, and policy toggle', async (suite) => {
  assert.ok(process.env.DATABASE_URL, 'Ejecuta test:integration dentro de Docker Compose.');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const database = 'agent_e2e_' + randomUUID().replaceAll('-', '');
  await admin.query('create database ' + database);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + database;
  const databaseUrl = url.toString();
  const pool = new Pool({ connectionString: databaseUrl });
  const scratch = await mkdtemp(join(tmpdir(), 'agent-e2e-'));
  const uploadDir = join(scratch, 'uploads');
  const proofDir = join(scratch, 'proofs');
  const hostPdfPath = join(scratch, 'tareaMN.pdf');
  await writeFile(hostPdfPath, SAMPLE_PDF);

  suite.after(async () => {
    await pool.end();
    try {
      await admin.query('drop database ' + database);
    } finally {
      await admin.end();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  const db = postgresDatabase(pool);
  await migrate(db, { migrationsFolder: 'src/adapters/persistence/migrations' });

  const accountId = 'student-e2e';
  const imports = new PostgresAssignmentImportRepository(db);
  await imports.recordImport(accountId, [
    {
      externalId: '301',
      course: 'Métodos Numéricos GB',
      title: 'Tarea 3 — Interpolación Polinomial',
      activityUrl: 'https://aula.example.invalid/2099B/mod/assign/view.php?id=301',
      deadline: '2099-12-10T04:59:00.000Z',
      destination: 'aula_virtual',
    },
    {
      externalId: '302',
      course: 'Ingeniería de Software II',
      title: 'Tarea 3 — Patrones de Diseño',
      activityUrl: 'https://aula.example.invalid/2099B/mod/assign/view.php?id=302',
      deadline: '2099-12-12T04:59:00.000Z',
      destination: 'aula_virtual',
    },
  ]);

  const app = await createApplication({
    databaseUrl,
    uploadDir,
    proofDir,
    demoMode: false,
    accountId,
    autoSyncIntervalSeconds: 0,
    host: '127.0.0.1',
    port: 0,
  }, false);

  const savedAppPublicUrl = process.env.APP_PUBLIC_URL;
  const savedHostWorkspacePath = process.env.HOST_WORKSPACE_PATH;
  delete process.env.APP_PUBLIC_URL;
  delete process.env.HOST_WORKSPACE_PATH;

  let subscriber: Awaited<ReturnType<typeof openEvents>> | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();

    // 1. Cross-site CSRF attempt against agent API is rejected with 403
    const csrfRes = await fetch(origin + '/api/agente/politica', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ policy: 'direct_on_exact_match' }),
    });
    assert.equal(csrfRes.status, 403);

    // 2. Open SSE stream and connect real MCP server + loopback client
    subscriber = await openEvents(origin);
    const rev0 = await subscriber.nextRevision();
    assert.ok(rev0?.startsWith(accountId + ':'));

    const client = new AulaPanelClient(origin);
    const mcp = new AulaMcpServer(client);

    const statusReply = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'aula_status', arguments: {} },
    }) as { result: { structuredContent: { policy: string; counts: { pendingTasks: number } } } };
    assert.equal(statusReply.result.structuredContent.policy, 'confirm_in_panel');
    assert.equal(statusReply.result.structuredContent.counts.pendingTasks, 2);

    // 3. MCP delivers PDF under default confirm_in_panel policy -> creates live proposal
    const deliverReply = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'aula_deliver_pdf',
        arguments: {
          filePath: hostPdfPath,
          instruction: 'tengo mi pdf en la ruta home de mn llamano tareaMN.pdf subelo a la tarea 3 de mn',
        },
      },
    }) as { result: { structuredContent: { outcome: string; proposal: { proposalId: string; taskId: string } } } };
    assert.equal(deliverReply.result.structuredContent.outcome, 'pending_confirmation');
    const proposalId = deliverReply.result.structuredContent.proposal.proposalId;
    const taskId = deliverReply.result.structuredContent.proposal.taskId;

    // SSE revision advances immediately after proposal creation
    const rev1 = await subscriber.nextRevision();
    assert.notEqual(rev1, rev0);

    // Both Agenda (/) and /agente show the live pending proposal card and universal multi-AI copy
    const agendaWithProposal = await (await fetch(origin + '/')).text();
    assert.match(agendaWithProposal, /Propuestas de entrega del Harness/);
    assert.match(agendaWithProposal, /Tarea 3 — Interpolación Polinomial/);
    assert.match(agendaWithProposal, /tareaMN\.pdf/);
    assert.match(agendaWithProposal, /Asistente de entrega rápida/);
    assert.match(agendaWithProposal, /MCP · Cualquier IA/);
    assert.doesNotMatch(agendaWithProposal, /Listo para Codex · MCP/);
    assert.match(agendaWithProposal, /subeme el laboratorio 8 de mn/);
    assert.doesNotMatch(agendaWithProposal, /~\/mn\/Lab08\.pdf/);

    const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const agentHtml = await (await fetch(origin + '/agente')).text();
    assert.match(agentHtml, /<h1>Agente · Harness<\/h1>/);
    assert.doesNotMatch(agentHtml, /Antigravity, Gemini, ChatGPT, Claude, Codex, OpenCode, Hermes, Gentle AI/);
    assert.doesNotMatch(agentHtml, /\/home\//);
    assert.match(agentHtml, /Confirmar en panel \(Recomendado\)/);
    assert.match(agentHtml, /Entrega directa del Harness/);
    assert.match(agentHtml, /Endpoint MCP local/);
    assert.match(agentHtml, new RegExp(`Endpoint MCP local[\\s\\S]*?${escapedOrigin}/mcp`));
    assert.match(agentHtml, /id="tab-mcp"[^>]*>MCP \(HTTP · Docker\)<\/button>/);
    assert.match(agentHtml, /id="tab-stdio"[^>]*>MCP STDIO \(Docker\)<\/button>/);
    assert.match(agentHtml, /id="tab-http"[^>]*>HTTP API local<\/button>/);
    assert.doesNotMatch(agentHtml, /MCP \(Codex \/ Claude\)/);
    assert.doesNotMatch(agentHtml, /Listo para Codex · MCP/);
    assert.doesNotMatch(agentHtml, /desde Codex\/MCP/);
    assert.match(agentHtml, /cualquier agente conectado por MCP\/CLI\/HTTP/);
    assert.match(agentHtml, new RegExp(`id="panel-mcp"[\\s\\S]*?${escapedOrigin}/mcp[\\s\\S]*?id="panel-stdio"`));
    assert.doesNotMatch(agentHtml, /id="panel-mcp"[\s\S]*?AULA_PANEL_URL[\s\S]*?id="panel-stdio"/);
    assert.match(agentHtml, /id="panel-stdio"[\s\S]*?docker[\s\S]*?dist\/adapters\/mcp\/stdio\.js[\s\S]*?id="panel-http"/);
    assert.match(agentHtml, new RegExp(`id="panel-http"[\\s\\S]*?${escapedOrigin}/api/agente/estado[\\s\\S]*?${escapedOrigin}/api/agente/entregas`));
    assert.doesNotMatch(agentHtml, new RegExp('id="panel-http"[\\s\\S]*?http://127\\.0\\.0\\.1:3000'));

    // Dynamic APP_PUBLIC_URL override + non-loopback rejection (HOST_WORKSPACE_PATH is never leaked)
    process.env.APP_PUBLIC_URL = 'http://127.0.0.1:3005/';
    process.env.HOST_WORKSPACE_PATH = '/home/private-user/should-never-appear/';
    const overrideHtml = await (await fetch(origin + '/agente')).text();
    assert.doesNotMatch(overrideHtml, /private-user/);
    assert.match(overrideHtml, /Endpoint MCP local[\s\S]*?http:\/\/127\.0\.0\.1:3005\/mcp/);
    assert.match(overrideHtml, /id="panel-mcp"[\s\S]*?http:\/\/127\.0\.0\.1:3005\/mcp[\s\S]*?id="panel-stdio"/);
    assert.match(overrideHtml, /id="panel-http"[\s\S]*?http:\/\/127\.0\.0\.1:3005\/api\/agente\/entregas/);

    process.env.APP_PUBLIC_URL = 'https://attacker.example:3005';
    const rejectedOverrideHtml = await (await fetch(origin + '/agente')).text();
    assert.doesNotMatch(rejectedOverrideHtml, /attacker\.example/);
    assert.match(rejectedOverrideHtml, new RegExp(`Endpoint MCP local[\\s\\S]*?${escapedOrigin}/mcp`));
    assert.match(rejectedOverrideHtml, new RegExp(`id="panel-http"[\\s\\S]*?${escapedOrigin}/api/agente/entregas`));
    delete process.env.APP_PUBLIC_URL;
    delete process.env.HOST_WORKSPACE_PATH;

    // POST error-rendering on /agente/politica also preserves the exact live origin
    const invalidPolicyRes = await fetch(origin + '/agente/politica', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ accountId, policy: 'invalid_mode', returnTo: '/agente' }),
      redirect: 'manual',
    });
    assert.equal(invalidPolicyRes.status, 400);
    const invalidPolicyHtml = await invalidPolicyRes.text();
    assert.match(invalidPolicyHtml, new RegExp(`id="panel-http"[\\s\\S]*?${escapedOrigin}/api/agente/entregas`));

    // 4. User authorizes proposal from panel -> creates delivery job
    const authRes = await fetch(origin + `/agente/propuestas/${proposalId}/autorizar`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ accountId, returnTo: '/' }),
      redirect: 'manual',
    });
    assert.equal(authRes.status, 303);

    // Find the created delivery job & settle it with a real PNG proof screenshot
    const proofStore = new LocalProofStore(proofDir);
    const proofKey = await proofStore.writePng(SAMPLE_PNG);
    const capturedAt = '2026-11-26T02:55:00.000Z';

    const jobRow = await pool.query<{ id: string }>(
      "select id from jobs where account_id = $1 and kind = 'delivery' order by created_at desc limit 1",
      [accountId],
    );
    const deliveryJobId = jobRow.rows[0]?.id;
    assert.ok(deliveryJobId);

    // Hold the account lock while settling (retry if WorkerLoop currently holds the non-blocking advisory lock).
    const workerRepo = new PostgresWorkerRepository(pool);
    let settled = false;
    for (let attempt = 0; attempt < 25 && !settled; attempt++) {
      await workerRepo.withAccountLock(accountId, async (session) => {
        await pool.query("update jobs set state = 'running' where id = $1", [deliveryJobId]);
        await session.settleDelivery(deliveryJobId, 'running', 'confirmed', 'Entrega confirmada.', {
          activityUrl: 'https://aula.example.invalid/2099B/mod/assign/view.php?id=301',
          visibleStatus: 'Enviado para calificar',
          fileName: 'tareaMN.pdf',
          proofKey,
          capturedAt,
        });
        settled = true;
      });
      if (!settled) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(settled, true, 'Expected to acquire account lock and settle delivery');

    // 5. Proof PNG endpoint serves verified image/png with security headers
    const proofRes = await fetch(origin + `/entregas/${deliveryJobId}/captura`);
    assert.equal(proofRes.status, 200, await proofRes.clone().text());
    assert.equal(proofRes.headers.get('content-type'), 'image/png');
    assert.equal(proofRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(proofRes.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await proofRes.arrayBuffer()), SAMPLE_PNG);

    // 6. Confirmed task drops OUT of Próximas and DOWN into Completadas with Ver captura button!
    const agendaAfterConfirm = await (await fetch(origin + '/')).text();
    const proximasIdx = agendaAfterConfirm.indexOf('>Próximas</h2>');
    const completadasIdx = agendaAfterConfirm.indexOf('>Completadas</h2>');
    const confirmedTaskIdx = agendaAfterConfirm.indexOf('Tarea 3 — Interpolación Polinomial');
    assert.ok(proximasIdx >= 0 && completadasIdx > proximasIdx);
    assert.ok(confirmedTaskIdx > completadasIdx, 'Confirmed task must appear under Completadas section, not Próximas');
    assert.match(agendaAfterConfirm, new RegExp(`data-proof-open="/entregas/${deliveryJobId}/captura"`));
    assert.match(agendaAfterConfirm, /Ver captura/);

    // Task detail page renders live SSE revision + proof screenshot preview
    const taskDetailHtml = await (await fetch(origin + `/tareas/${taskId}`)).text();
    assert.match(taskDetailHtml, /data-live-revision="/);
    assert.match(taskDetailHtml, new RegExp(`src="/entregas/${deliveryJobId}/captura"`));
    assert.match(taskDetailHtml, /Ampliar captura/);

    // 7. MCP aula_check_job returns inline image/png block matching the exact proof PNG!
    const checkJobReply = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'aula_check_job', arguments: { jobId: deliveryJobId, includeScreenshot: true } },
    }) as { result: { content: Array<{ type: string; mimeType?: string; data?: string }> } };
    const imageBlock = checkJobReply.result.content.find((b) => b.type === 'image');
    assert.ok(imageBlock, 'Expected MCP aula_check_job to return inline proof image');
    assert.equal(imageBlock.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(imageBlock.data!, 'base64'), SAMPLE_PNG);

    // 8. Switch policy to direct_on_exact_match via panel form and verify ambiguous command still refuses!
    const policyRes = await fetch(origin + '/agente/politica', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ accountId, policy: 'direct_on_exact_match', returnTo: '/agente' }),
      redirect: 'manual',
    });
    assert.equal(policyRes.status, 303);

    const analyzerRes = await fetch(origin + '/api/agente/analizar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'sube informe a la tarea 3 de is' }),
    });
    assert.equal(analyzerRes.status, 200);
    const analyzed = await analyzerRes.json() as { kind: string; match: { task: { externalId: string } } | null };
    assert.equal(analyzed.kind, 'exact');
    assert.equal(analyzed.match?.task.externalId, '302');

    // 9. Built-in Streamable HTTP MCP endpoint (/mcp): initialize, 202 notification, 9 tools, pdfBase64 delivery, 405 GET, 403 cross-origin
    const mcpGetRes = await fetch(origin + '/mcp');
    assert.equal(mcpGetRes.status, 405);
    assert.equal(mcpGetRes.headers.get('allow'), 'POST');

    const mcpEvilOrigin = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(mcpEvilOrigin.status, 403);

    const mcpInitRes = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
    });
    assert.equal(mcpInitRes.status, 200);
    assert.equal(mcpInitRes.headers.get('mcp-protocol-version'), '2025-06-18');
    const mcpNotifRes = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(mcpNotifRes.status, 202);

    const mcpToolsRes = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list' }),
    });
    assert.equal(mcpToolsRes.status, 200);
    const mcpToolsJson = await mcpToolsRes.json() as { result: { tools: Array<{ name: string }> } };
    assert.equal(mcpToolsJson.result.tools.length, 9);
    assert.ok(mcpToolsJson.result.tools.some((t) => t.name === 'aula_discard_delivery'));

    // Deliver PDF via pdfBase64 over HTTP /mcp to task 302 (under direct_on_exact_match), settle as failed, then discard via panel & API!
    const base64DeliverRes = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'aula_deliver_pdf',
          arguments: {
            pdfBase64: SAMPLE_PDF.toString('base64'),
            fileName: 'LabIS3.pdf',
            instruction: 'sube informe a la tarea 3 de is',
            waitForResult: false,
          },
        },
      }),
    });
    assert.equal(base64DeliverRes.status, 200);
    const base64DeliverJson = await base64DeliverRes.json() as {
      result: { isError?: boolean; structuredContent: { outcome: string; jobId: string; task: { taskId: string } } };
    };
    assert.notEqual(base64DeliverJson.result.isError, true);
    assert.equal(base64DeliverJson.result.structuredContent.outcome, 'authorized');
    const isTaskId = base64DeliverJson.result.structuredContent.task.taskId;
    const isJobId = base64DeliverJson.result.structuredContent.jobId;

    // Move task 302 job to needs_verification, verify UI renders both Verify & Discard buttons, then discard via panel POST!
    await pool.query("update jobs set state = 'needs_verification', summary = 'Por verificar' where id = $1", [isJobId]);
    const stuckTaskHtml = await (await fetch(origin + `/tareas/${isTaskId}`)).text();
    assert.match(stuckTaskHtml, /Verificar estado en DUTIC \(solo lectura\)/);
    assert.match(stuckTaskHtml, /Eliminar intento y volver a intentar/);
    assert.match(stuckTaskHtml, new RegExp(`/tareas/${isTaskId}/entregas/${isJobId}/eliminar`));

    // Cross-site DELETE on API must be rejected by PanelWriteGuard
    const evilDeleteRes = await fetch(origin + `/api/agente/tareas/${isTaskId}/entregas/${isJobId}`, {
      method: 'DELETE',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(evilDeleteRes.status, 403);

    // Discard via web panel form -> 303 and Autorizar y entregar immediately re-enabled!
    const discardPanelRes = await fetch(origin + `/tareas/${isTaskId}/entregas/${isJobId}/eliminar`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ accountId }),
      redirect: 'manual',
    });
    assert.equal(discardPanelRes.status, 303);
    const resetTaskHtml = await (await fetch(origin + `/tareas/${isTaskId}`)).text();
    assert.doesNotMatch(resetTaskHtml, /Eliminar intento y volver a intentar/);
    assert.match(resetTaskHtml, /<button type="submit" class="btn btn-primary">/);

    // Confirmed delivery (taskId / deliveryJobId) MUST NOT be deletable via API (409)
    const confirmDeleteRes = await fetch(origin + `/api/agente/tareas/${taskId}/entregas/${deliveryJobId}`, {
      method: 'DELETE',
    });
    assert.equal(confirmDeleteRes.status, 409);
  } finally {
    if (savedAppPublicUrl === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = savedAppPublicUrl;
    if (savedHostWorkspacePath === undefined) delete process.env.HOST_WORKSPACE_PATH;
    else process.env.HOST_WORKSPACE_PATH = savedHostWorkspacePath;
    subscriber?.close();
    await app.close();
  }
});

test('presentProposal maps universal AI and harness source labels', () => {
  const base = {
    proposalId: '0ecd25cb-61f5-49a7-83b9-bdb97e5afdb0',
    accountId: 'student',
    taskId: 'ad5b89bd-6ce4-4214-b479-c0e59114ca29',
    taskTitle: 'Laboratorio 8',
    taskCourse: 'Métodos Numéricos',
    pdfId: 'c675f0c7-98b5-4403-a815-d2ee12e8cd14',
    pdfOriginalName: 'Lab08.pdf',
    pdfSha256: '0123456789abcdef0123456789abcdef',
    instruction: 'subeme el laboratorio 8 de mn',
    state: 'pending' as const,
    deliveryJobId: null,
    createdAt: '2026-11-26T12:00:00.000Z',
    updatedAt: '2026-11-26T12:00:00.000Z',
  };
  const expected: Record<string, string> = {
    'ai-mcp': 'Agente · MCP',
    gemini: 'Gemini',
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    antigravity: 'Antigravity',
    hermes: 'Hermes',
    'gentle-ai': 'Gentle AI',
    'codex-mcp': 'Codex · MCP',
    'agent-cli': 'CLI local',
    panel: 'Asistente web',
  };
  for (const [source, label] of Object.entries(expected)) {
    assert.equal(presentProposal({ ...base, source }).sourceLabel, label, `Expected label for source "${source}"`);
  }
});
