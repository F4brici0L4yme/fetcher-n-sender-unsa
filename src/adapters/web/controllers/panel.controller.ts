import {
  BadRequestException, Body, ConflictException, Controller, Get, Header, Inject, NotFoundException,
  Optional, Param, ParseUUIDPipe, PayloadTooLargeException, Post, Query, Redirect, Render, Req, Res,
  Sse, UploadedFile, UseFilters, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import {
  AutorizarPropuestaAgente, ConsultarCapturaEntrega, ListarPropuestasAgente,
  PoliticaAutomatizacion, PrepararEntregaAgente, RechazarPropuestaAgente,
} from '../../../core/application/agent';
import { PersonalNotes } from '../../../core/application/notes';
import { AUTO_SYNC_MONITOR, type AutoSyncMonitor } from '../../../core/application/ports/agent';
import { PERSONAL_SESSION, type PersonalSession } from '../../../core/application/ports/browser-session';
import {
  BuscarTareas, CargarPdf, ConsultarTrabajo, ConsultarUltimaBusqueda, DescartarIntentoEntrega,
  ListarTareas, MAX_PDF_BYTES, SolicitarEntrega, VerificarEntrega,
} from '../../../core/application/tasks';
import { compareAgendaItems } from '../../../core/domain/agenda';
import { BrowserSessionError } from '../../../core/domain/browser-session';
import { ApplicationError, type TaskView } from '../../../core/domain/model';
import { presentNote } from '../notes.presenter';
import { assertCurrentAccount, currentAccount, type PanelAccount } from '../panel-account';
import { PanelAssistedCapture, PanelLiveUpdates } from '../panel-assisted-capture';
import {
  presentAutoSync, presentJob, presentPolicy, presentProposal, presentSession, presentSidebar, presentTask,
  type SidebarSection,
} from '../panel.presenter';
import { PANEL_ACCOUNT, PANEL_DEMO } from '../panel.tokens';
import { PanelWriteGuard } from '../panel-write.guard';
import { PdfUploadErrorFilter } from './pdf-upload.filter';
import { TaskPage } from './task-page';

type AgendaViewMode = 'todas' | 'tareas' | 'notas' | 'completadas';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseAgendaView(raw: string | undefined): AgendaViewMode {
  if (raw === 'tareas' || raw === 'notas' || raw === 'completadas') return raw;
  return 'todas';
}

function parseReturnTo(body: unknown, allowed: readonly string[], fallback: string): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const returnTo = (body as Record<string, unknown>).returnTo;
    if (typeof returnTo === 'string' && allowed.includes(returnTo)) return returnTo;
  }
  return fallback;
}

function readBodyString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const nonEmpty = value.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return nonEmpty ?? (typeof value[0] === 'string' ? value[0] : undefined);
  }
  return undefined;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const DEFAULT_LIVE_ORIGIN = 'http://127.0.0.1:3000';
const DEFAULT_PORTAL_URL = 'https://aulavirtual.unsa.edu.pe/2026B/';
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

function resolveConfiguredPortalUrl(): string {
  const raw = process.env.AULA_PORTAL_URL?.trim();
  if (!raw || CONTROL_CHAR_PATTERN.test(raw)) return DEFAULT_PORTAL_URL;
  const parsed = URL.parse(raw);
  if (
    !parsed
    || parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname.startsWith('//')
  ) {
    return DEFAULT_PORTAL_URL;
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

function parseLoopbackHttpOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) return null;
  const parsed = URL.parse(trimmed);
  if (!parsed || parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return parsed.origin;
}

function resolveLiveOrigin(request?: Request): string {
  const configured = process.env.APP_PUBLIC_URL?.trim();
  if (configured) {
    const parsed = parseLoopbackHttpOrigin(configured);
    if (parsed) return parsed;
  }
  const host = request?.get('host')?.trim();
  if (host && !/[/?#@\s]/.test(host) && !CONTROL_CHAR_PATTERN.test(host)) {
    const parsed = parseLoopbackHttpOrigin(`http://${host}`);
    if (parsed) return parsed;
  }
  return DEFAULT_LIVE_ORIGIN;
}

function buildMcpHttpSnippet(liveOrigin: string): string {
  return JSON.stringify({
    mcpServers: {
      'aula-virtual-unsa': {
        url: `${liveOrigin}/mcp`,
      },
    },
  }, null, 2);
}

function buildMcpStdioSnippet(): string {
  return JSON.stringify({
    mcpServers: {
      'aula-virtual-unsa': {
        command: 'docker',
        args: ['compose', 'exec', '-T', 'app', 'node', 'dist/adapters/mcp/stdio.js'],
      },
    },
  }, null, 2);
}

function buildHttpSnippet(liveOrigin: string): string {
  return [
    '# Estado de sesión, política activa y tareas sincronizadas',
    `curl -s ${liveOrigin}/api/agente/estado`,
    `curl -s "${liveOrigin}/api/agente/tareas?q=laboratorio%208%20de%20mn"`,
    '',
    '# Preparar o ejecutar entrega de PDF (API local en loopback)',
    `curl -s -X POST ${liveOrigin}/api/agente/entregas \\`,
    '  -F "pdf=@./entregas/Lab08.pdf;type=application/pdf" \\',
    '  -F "instruction=subeme el laboratorio 8 de mn" \\',
    '  -F "source=ai-mcp" \\',
    '  -F "executeIfAllowed=true"',
  ].join('\n');
}

interface CommandFeedbackExtras {
  commandError?: string;
  commandNotice?: string;
  commandInstruction?: string;
  commandCandidates?: Array<{ taskId: string; title: string; course: string; deadlineLabel: string }>;
}

@Controller()
@UseGuards(PanelWriteGuard)
export class PanelController {
  constructor(
    @Inject(PANEL_ACCOUNT) private readonly account: PanelAccount,
    @Inject(PANEL_DEMO) private readonly demoMode: boolean,
    private readonly search: BuscarTareas,
    private readonly list: ListarTareas,
    private readonly loadPdf: CargarPdf,
    private readonly send: SolicitarEntrega,
    private readonly status: ConsultarTrabajo,
    private readonly latest: ConsultarUltimaBusqueda,
    private readonly taskPage: TaskPage,
    @Optional() private readonly assisted?: PanelAssistedCapture,
    @Optional() private readonly live?: PanelLiveUpdates,
    @Optional() private readonly notes?: PersonalNotes,
    @Optional() @Inject(PERSONAL_SESSION) private readonly session?: PersonalSession,
    @Optional() @Inject(AUTO_SYNC_MONITOR) private readonly autoSync?: AutoSyncMonitor,
    @Optional() private readonly verifyDelivery?: VerificarEntrega,
    @Optional() private readonly discardDelivery?: DescartarIntentoEntrega,
    @Optional() private readonly policy?: PoliticaAutomatizacion,
    @Optional() private readonly proposals?: ListarPropuestasAgente,
    @Optional() private readonly prepareAgent?: PrepararEntregaAgente,
    @Optional() private readonly authorizeAgent?: AutorizarPropuestaAgente,
    @Optional() private readonly rejectAgent?: RechazarPropuestaAgente,
    @Optional() private readonly readProof?: ConsultarCapturaEntrega,
  ) {}

  @Get()
  async index(
    @Res() response: Response,
    @Query('job', new ParseUUIDPipe({ optional: true })) jobId?: string,
    @Query('vista') vista?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (vista === 'sesion') {
      response.redirect(302, '/sesion');
      return;
    }
    if (vista === 'agente') {
      response.redirect(302, '/agente');
      return;
    }
    response.render('panel-index', await this.buildIndexView(jobId, { vista }));
  }

  @Get('sesion')
  @Header('Cache-Control', 'no-store')
  @Render('panel-session')
  async sessionPage() {
    return this.buildSessionView();
  }

  @Get('agente')
  @Header('Cache-Control', 'no-store')
  @Render('panel-agent')
  async agentPage(@Req() request: Request) {
    return this.buildAgentView({}, request);
  }

  @Get('entregas/:jobId/captura')
  async deliveryProof(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Query('download') download: string | undefined,
    @Res() response: Response,
  ) {
    if (!this.readProof) throw new NotFoundException('La captura de comprobantes no está habilitada.');
    const accountId = currentAccount(this.account);
    try {
      const proof = await this.readProof.execute(accountId, jobId);
      const disposition = download === '1' || download === 'true' ? 'attachment' : 'inline';
      response.setHeader('Content-Type', 'image/png');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Disposition', `${disposition}; filename="comprobante-${jobId.slice(0, 8)}.png"`);
      response.send(Buffer.from(proof.content));
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'not_found') {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Sse('eventos/tareas')
  changes() {
    if (this.assisted) return this.assisted.watch();
    if (this.live) return this.live.watch();
    throw new NotFoundException();
  }

  @Post('busquedas')
  @Redirect('/', 303)
  async queueSearch(@Body() body?: unknown) {
    if (this.assisted) throw new ConflictException('Inicia la captura desde el chat de Codex.');
    const accountId = this.pinnedAccount(body);
    const { jobId } = await this.search.execute(accountId);
    return { url: '/?job=' + jobId };
  }

  @Post('agente/politica')
  async updateAgentPolicy(@Body() body: unknown, @Req() request: Request, @Res() response: Response) {
    if (!this.policy) throw new NotFoundException('La automatización del agente no está habilitada.');
    const accountId = this.pinnedAccount(body);
    const returnTo = parseReturnTo(body, ['/agente', '/'], '/agente');
    try {
      await this.policy.set(accountId, readBodyString(body, 'policy'));
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'invalid_policy') {
        response.status(400).render('panel-agent', await this.buildAgentView({ commandError: error.message }, request));
        return;
      }
      throw error;
    }
    response.redirect(303, returnTo);
  }

  @Post('agente/comando')
  @UseInterceptors(FileInterceptor('pdf', { limits: { files: 1, fields: 6, fileSize: MAX_PDF_BYTES + 1 } }))
  async submitQuickCommand(
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (this.assisted) throw new ConflictException('La captura asistida solo registra tareas.');
    if (!this.prepareAgent) throw new NotFoundException('La automatización del agente no está habilitada.');
    const accountId = this.pinnedAccount(body);
    const returnTo = parseReturnTo(body, ['/', '/agente'], '/');
    const instruction = readBodyString(body, 'instruction') ?? '';
    const rawTaskId = readBodyString(body, 'taskId')?.trim();
    const authorizeNow = readBodyString(body, 'authorizeNow') === 'true';

    const renderFailure = async (status: number, extras: CommandFeedbackExtras) => {
      if (returnTo === '/agente') {
        response.status(status).render('panel-agent', await this.buildAgentView(extras, request));
      } else {
        response.status(status).render('panel-index', await this.buildIndexView(undefined, extras));
      }
    };

    if (file && file.size > MAX_PDF_BYTES) {
      await renderFailure(413, { commandError: 'El archivo PDF supera el límite de 20 MiB.', commandInstruction: instruction });
      return;
    }
    if (!file) {
      await renderFailure(400, { commandError: 'Selecciona el archivo PDF que deseas entregar.', commandInstruction: instruction });
      return;
    }
    if (rawTaskId && !UUID_PATTERN.test(rawTaskId)) {
      await renderFailure(400, { commandError: 'Selecciona una tarea válida.', commandInstruction: instruction });
      return;
    }

    try {
      const prepared = await this.prepareAgent.execute({
        accountId,
        instruction,
        taskId: rawTaskId || undefined,
        originalName: file.originalname,
        content: file.buffer,
        source: 'panel',
        allowDirectExecution: false,
      });

      if (prepared.outcome === 'no_match') {
        await renderFailure(400, {
          commandError: 'No encontramos ninguna tarea pendiente que coincida con esa instrucción. Prueba indicar el curso y número de tarea.',
          commandInstruction: instruction,
        });
        return;
      }
      if (prepared.outcome === 'ambiguous') {
        await renderFailure(409, {
          commandError: 'Hay varias tareas posibles. Selecciona la tarea exacta y vuelve a confirmar.',
          commandInstruction: instruction,
          commandCandidates: prepared.candidates.map((c) => {
            const p = presentTask(c.task, this.demoMode);
            return { taskId: c.task.taskId, title: c.task.title, course: c.task.course, deadlineLabel: p.deadlineLabel };
          }),
        });
        return;
      }
      if (prepared.outcome === 'pending_confirmation' && authorizeNow && this.authorizeAgent) {
        await this.authorizeAgent.execute(accountId, prepared.proposal.proposalId);
        response.redirect(303, '/tareas/' + prepared.task.taskId);
        return;
      }
      response.redirect(303, returnTo);
    } catch (error) {
      if (error instanceof ApplicationError) {
        const status = error.code === 'not_found' ? 404 : error.code === 'invalid_pdf' ? 400 : 409;
        await renderFailure(status, { commandError: error.message, commandInstruction: instruction });
        return;
      }
      throw error;
    }
  }

  @Post('agente/propuestas/:proposalId/autorizar')
  async authorizeProposalForm(
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (!this.authorizeAgent) throw new NotFoundException('La automatización del agente no está habilitada.');
    const accountId = this.pinnedAccount(body);
    const returnTo = parseReturnTo(body, ['/', '/agente'], '/agente');
    try {
      const { proposal } = await this.authorizeAgent.execute(accountId, proposalId);
      response.redirect(303, returnTo === '/' ? '/' : '/tareas/' + proposal.taskId);
    } catch (error) {
      if (error instanceof ApplicationError) {
        const status = error.code === 'not_found' ? 404 : 409;
        if (returnTo === '/agente') {
          response.status(status).render('panel-agent', await this.buildAgentView({ commandError: error.message }, request));
        } else {
          response.status(status).render('panel-index', await this.buildIndexView(undefined, { commandError: error.message }));
        }
        return;
      }
      throw error;
    }
  }

  @Post('agente/propuestas/:proposalId/rechazar')
  async rejectProposalForm(
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (!this.rejectAgent) throw new NotFoundException('La automatización del agente no está habilitada.');
    const accountId = this.pinnedAccount(body);
    const returnTo = parseReturnTo(body, ['/', '/agente'], '/agente');
    try {
      await this.rejectAgent.execute(accountId, proposalId);
      response.redirect(303, returnTo);
    } catch (error) {
      if (error instanceof ApplicationError) {
        const status = error.code === 'not_found' ? 404 : 409;
        if (returnTo === '/agente') {
          response.status(status).render('panel-agent', await this.buildAgentView({ commandError: error.message }, request));
        } else {
          response.status(status).render('panel-index', await this.buildIndexView(undefined, { commandError: error.message }));
        }
        return;
      }
      throw error;
    }
  }

  @Post('sesion/conectar')
  async connectSession(@Body() body: unknown, @Res() response: Response) {
    if (!this.session) throw new NotFoundException('La sesión personal no está habilitada.');
    const accountId = this.pinnedAccount(body);
    const returnTo = parseReturnTo(body, ['/', '/sesion'], '/');
    const identity = readBodyString(body, 'identity');
    if (typeof identity !== 'string') {
      const errorExtras = {
        sessionError: 'Ingresa el correo que aparece en tu perfil de Aula Virtual.',
      };
      if (returnTo === '/sesion') {
        response.status(400).render('panel-session', await this.buildSessionView(errorExtras));
      } else {
        response.status(400).render('panel-index', await this.buildIndexView(undefined, errorExtras));
      }
      return;
    }
    try {
      await this.session.connect(identity);
    } catch (error) {
      if (error instanceof BrowserSessionError) {
        const status = error.code === 'invalid_identity' ? 400 : error.code === 'browser_busy' ? 409 : 503;
        const errorExtras = { sessionError: error.message, sessionIdentity: identity };
        if (returnTo === '/sesion') {
          response.status(status).render('panel-session', await this.buildSessionView(errorExtras));
        } else {
          response.status(status).render('panel-index', await this.buildIndexView(undefined, errorExtras));
        }
        return;
      }
      throw error;
    }
    if (accountId !== this.session.current()) {
      // Account switched to the connecting identity's isolated namespace.
    }
    response.redirect(303, returnTo);
  }

  @Post('sesion/desconectar')
  async disconnectSession(@Body() body: unknown, @Res() response: Response) {
    if (!this.session) throw new NotFoundException('La sesión personal no está habilitada.');
    this.pinnedAccount(body);
    const returnTo = parseReturnTo(body, ['/', '/sesion'], '/');
    try {
      await this.session.disconnect();
    } catch (error) {
      if (error instanceof BrowserSessionError) {
        const status = error.code === 'browser_busy' ? 409 : 503;
        const errorExtras = { sessionError: error.message };
        if (returnTo === '/sesion') {
          response.status(status).render('panel-session', await this.buildSessionView(errorExtras));
        } else {
          response.status(status).render('panel-index', await this.buildIndexView(undefined, errorExtras));
        }
        return;
      }
      throw error;
    }
    response.redirect(303, returnTo);
  }

  @Get('tareas/:taskId')
  @Header('Cache-Control', 'no-store')
  @Render('panel-task')
  task(@Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.taskPage.view(taskId);
  }

  @Post('tareas/:taskId/pdf')
  @UseInterceptors(FileInterceptor('pdf', { limits: { files: 1, fields: 1, fileSize: MAX_PDF_BYTES + 1 } }))
  @UseFilters(PdfUploadErrorFilter)
  async upload(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: unknown,
    @Res() response: Response,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (this.assisted) throw new ConflictException('La captura asistida solo registra tareas.');
    const accountId = this.pinnedAccount(body);
    if (file && file.size > MAX_PDF_BYTES) throw new PayloadTooLargeException();
    try {
      if (!file) throw new ApplicationError('invalid_pdf', 'Selecciona un PDF.');
      await this.loadPdf.execute({
        accountId, taskId, originalName: file.originalname, content: file.buffer,
      });
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      if (error.code === 'not_found') throw new NotFoundException(error.message);
      if (error.code !== 'invalid_pdf') throw error;
      response.status(400).render('panel-task', await this.taskPage.view(taskId, { uploadError: error.message }));
      return;
    }
    response.redirect(303, '/tareas/' + taskId);
  }

  @Post('tareas/:taskId/entregas')
  async authorize(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body('pdfId', ParseUUIDPipe) pdfId: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    if (this.assisted) throw new ConflictException('La captura asistida solo registra tareas.');
    const accountId = this.pinnedAccount(body);
    try {
      await this.send.execute({ accountId, taskId, pdfId });
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      if (error.code === 'not_found') throw new NotFoundException(error.message);
      if (!['stale_pdf', 'unsupported_destination', 'delivery_pending'].includes(error.code)) throw error;
      response.status(409).render('panel-task', await this.taskPage.view(taskId, { deliveryError: error.message }));
      return;
    }
    response.redirect(303, '/tareas/' + taskId);
  }

  @Post('tareas/:taskId/entregas/:jobId/verificar')
  async requestDeliveryVerification(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    if (!this.verifyDelivery) throw new NotFoundException('La verificación de entregas no está habilitada.');
    const accountId = this.pinnedAccount(body);
    try {
      await this.verifyDelivery.execute(accountId, jobId);
      response.redirect(303, '/tareas/' + taskId);
    } catch (error) {
      if (error instanceof ApplicationError) {
        if (error.code === 'not_found') throw new NotFoundException(error.message);
        if (error.code === 'delivery_not_uncertain') {
          response.status(409).render('panel-task', await this.taskPage.view(taskId, { deliveryError: error.message }));
          return;
        }
      }
      throw error;
    }
  }

  @Post('tareas/:taskId/entregas/:jobId/eliminar')
  async discardDeliveryAttempt(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    if (this.assisted) throw new ConflictException('La captura asistida solo registra tareas.');
    if (!this.discardDelivery) throw new NotFoundException('El descarte de intentos no está habilitado.');
    const accountId = this.pinnedAccount(body);
    try {
      await this.discardDelivery.execute(accountId, taskId, jobId);
      response.redirect(303, '/tareas/' + taskId);
    } catch (error) {
      if (error instanceof ApplicationError) {
        if (error.code === 'not_found') throw new NotFoundException(error.message);
        if (error.code === 'delivery_confirmed' || error.code === 'delivery_active') {
          response.status(409).render('panel-task', await this.taskPage.view(taskId, { deliveryError: error.message }));
          return;
        }
      }
      throw error;
    }
  }

  @Get('trabajos/:jobId')
  async job(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return presentJob(await this.readJob(jobId), this.demoMode);
  }

  private pinnedAccount(body: unknown): string {
    const submitted = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).accountId : undefined;
    assertCurrentAccount(this.account, submitted);
    return currentAccount(this.account);
  }

  private isAgentEnabled(): boolean {
    return Boolean(!this.assisted && this.prepareAgent && this.policy);
  }

  private async buildSessionView(extras: { sessionError?: string; sessionIdentity?: string } = {}) {
    const accountId = currentAccount(this.account);
    const captureRevision = this.assisted
      ? await this.assisted.currentRevision()
      : await this.live?.currentRevision();
    const [tasks, noteList, sessionStatus, proposalList] = await Promise.all([
      this.list.execute(accountId),
      this.notes ? this.notes.list(accountId) : Promise.resolve([]),
      this.session ? this.session.status() : Promise.resolve(null),
      this.proposals ? this.proposals.execute(accountId, 30) : Promise.resolve([]),
    ]);
    const session = presentSession(sessionStatus);
    const autoSync = presentAutoSync(this.autoSync?.status());
    const liveRevision = this.assisted ? null : (captureRevision ?? null);
    const completedCount = noteList.filter((n) => n.status === 'completado').length
      + tasks.filter((t) => t.delivery?.state === 'confirmed').length;
    const portalUrl = resolveConfiguredPortalUrl();

    return {
      accountId,
      demoMode: this.demoMode,
      portalUrl,
      assistedCapture: this.assisted ? { ready: this.assisted.ready, revision: captureRevision ?? '' } : null,
      liveRevision,
      session,
      autoSync,
      sidebar: presentSidebar({
        active: 'sesion',
        notesEnabled: Boolean(this.notes),
        agentEnabled: this.isAgentEnabled(),
        session,
        autoSync,
        demoMode: this.demoMode,
        assistedMode: Boolean(this.assisted),
        liveActive: Boolean(this.assisted || this.live),
        counts: {
          tasks: tasks.filter((t) => t.delivery?.state !== 'confirmed').length,
          notes: noteList.filter((n) => n.status !== 'completado').length,
          completed: completedCount,
          proposals: proposalList.filter((p) => p.state === 'pending').length,
        },
      }),
      ...extras,
    };
  }

  private async buildAgentView(extras: CommandFeedbackExtras = {}, request?: Request) {
    const accountId = currentAccount(this.account);
    const liveOrigin = resolveLiveOrigin(request);
    const captureRevision = this.assisted
      ? await this.assisted.currentRevision()
      : await this.live?.currentRevision();
    const [tasks, noteList, sessionStatus, deliveryPolicy, proposalList] = await Promise.all([
      this.list.execute(accountId),
      this.notes ? this.notes.list(accountId) : Promise.resolve([]),
      this.session ? this.session.status() : Promise.resolve(null),
      this.policy ? this.policy.get(accountId) : Promise.resolve('confirm_in_panel' as const),
      this.proposals ? this.proposals.execute(accountId, 25) : Promise.resolve([]),
    ]);
    const session = presentSession(sessionStatus);
    const autoSync = presentAutoSync(this.autoSync?.status());
    const liveRevision = this.assisted ? null : (captureRevision ?? null);
    const presentedTasks = tasks.map((task) => presentTask(task, this.demoMode));
    const pendingTasks = presentedTasks.filter((t) => !t.isConfirmed && t.destination === 'aula_virtual');
    const deliveredTasks = presentedTasks.filter((t) => Boolean(t.delivery));
    const presentedProposals = proposalList.map(presentProposal);
    const pendingProposals = presentedProposals.filter((p) => p.isPending);
    const completedCount = noteList.filter((n) => n.status === 'completado').length
      + tasks.filter((t) => t.delivery?.state === 'confirmed').length;

    return {
      accountId,
      demoMode: this.demoMode,
      agentEnabled: this.isAgentEnabled(),
      assistedCapture: this.assisted ? { ready: this.assisted.ready, revision: captureRevision ?? '' } : null,
      liveRevision,
      liveOrigin,
      session,
      autoSync,
      policy: presentPolicy(deliveryPolicy),
      pendingProposals,
      recentProposals: presentedProposals.slice(0, 8),
      deliveredTasks,
      openTasks: pendingTasks,
      mcpHttpSnippet: buildMcpHttpSnippet(liveOrigin),
      mcpStdioSnippet: buildMcpStdioSnippet(),
      httpSnippet: buildHttpSnippet(liveOrigin),
      sidebar: presentSidebar({
        active: 'agente',
        notesEnabled: Boolean(this.notes),
        agentEnabled: this.isAgentEnabled(),
        session,
        autoSync,
        demoMode: this.demoMode,
        assistedMode: Boolean(this.assisted),
        liveActive: Boolean(this.assisted || this.live),
        counts: {
          tasks: tasks.filter((t) => t.delivery?.state !== 'confirmed').length,
          notes: noteList.filter((n) => n.status !== 'completado').length,
          completed: completedCount,
          proposals: pendingProposals.length,
        },
      }),
      ...extras,
    };
  }

  private async buildIndexView(
    jobId?: string,
    extras: { vista?: string; sessionError?: string; sessionIdentity?: string } & CommandFeedbackExtras = {},
  ) {
    const accountId = currentAccount(this.account);
    const activeView = parseAgendaView(extras.vista);
    // Read the marker first so a commit between queries still triggers an update.
    const captureRevision = this.assisted
      ? await this.assisted.currentRevision()
      : await this.live?.currentRevision();
    const [tasks, noteList, job, sessionStatus, proposalList] = await Promise.all([
      this.list.execute(accountId),
      this.notes ? this.notes.list(accountId) : Promise.resolve([]),
      jobId && !this.assisted ? this.readJob(jobId) : this.latest.execute(accountId),
      this.session ? this.session.status() : Promise.resolve(null),
      this.proposals ? this.proposals.execute(accountId, 20) : Promise.resolve([]),
    ]);

    const presentedTasks = tasks.map((task) => {
      const view = presentTask(task, this.demoMode);
      return {
        ...view,
        kind: 'task' as const,
        id: task.taskId,
        isNote: false,
        completed: view.isConfirmed,
      };
    });
    const presentedNotes = noteList.map((note) => ({
      ...presentNote(note),
      id: note.noteId,
    }));
    const combined = [...presentedTasks, ...presentedNotes].sort(compareAgendaItems);
    const sortedTasks = [...presentedTasks].sort(compareAgendaItems);
    const sortedNotes = [...presentedNotes].sort(compareAgendaItems);
    const completedArchive = [
      ...presentedNotes.filter((note) => note.completed),
      ...presentedTasks.filter((task) => task.isConfirmed),
    ].sort(compareAgendaItems);

    const session = presentSession(sessionStatus);
    const autoSync = presentAutoSync(this.autoSync?.status());
    const liveRevision = this.assisted ? null : (captureRevision ?? null);
    const pendingProposals = proposalList.map(presentProposal).filter((p) => p.isPending);
    const openDeliverableTasks = presentedTasks.filter((t) => !t.isConfirmed && t.destination === 'aula_virtual');

    const groups = this.buildGroups(activeView, combined, sortedTasks, sortedNotes, completedArchive);
    const totalVisible = groups.reduce((acc, group) => acc + group.tasks.length, 0);
    const viewMeta = this.buildViewMeta(activeView, totalVisible === 0, session);
    const sidebarActive: SidebarSection = activeView === 'todas' ? 'agenda' : activeView;

    return {
      accountId,
      demoMode: this.demoMode,
      notesEnabled: Boolean(this.notes),
      agentEnabled: this.isAgentEnabled(),
      assistedCapture: this.assisted ? { ready: this.assisted.ready, revision: captureRevision ?? '' } : null,
      liveRevision,
      session,
      autoSync,
      pendingProposals,
      openDeliverableTasks,
      showQuickAssistant: this.isAgentEnabled() && (activeView === 'todas' || activeView === 'tareas'),
      view: viewMeta,
      sidebar: presentSidebar({
        active: sidebarActive,
        notesEnabled: Boolean(this.notes),
        agentEnabled: this.isAgentEnabled(),
        session,
        autoSync,
        demoMode: this.demoMode,
        assistedMode: Boolean(this.assisted),
        liveActive: Boolean(this.assisted || this.live),
        counts: {
          tasks: presentedTasks.filter((t) => !t.isConfirmed).length,
          notes: presentedNotes.filter((note) => !note.completed).length,
          completed: completedArchive.length,
          proposals: pendingProposals.length,
        },
      }),
      groups,
      isEmptyView: totalVisible === 0,
      job: job?.kind === 'search' ? presentJob(job, this.demoMode) : null,
      sessionError: extras.sessionError,
      sessionIdentity: extras.sessionIdentity,
      commandError: extras.commandError,
      commandNotice: extras.commandNotice,
      commandInstruction: extras.commandInstruction,
      commandCandidates: extras.commandCandidates,
    };
  }

  private buildGroups(
    activeView: AgendaViewMode,
    combined: Array<{ deadline: string | null; completed: boolean }>,
    sortedTasks: Array<{ deadline: string | null; completed: boolean }>,
    sortedNotes: Array<{ deadline: string | null; completed: boolean }>,
    completedArchive: Array<{ deadline: string | null; completed: boolean }>,
  ) {
    if (activeView === 'tareas') {
      const upcoming = sortedTasks.filter((item) => item.deadline !== null && !item.completed);
      const undated = sortedTasks.filter((item) => item.deadline === null && !item.completed);
      const completed = sortedTasks.filter((item) => item.completed);
      return [
        { label: 'Próximas', count: upcoming.length, empty: 'No hay tareas de Aula Virtual pendientes con fecha próxima.', tasks: upcoming },
        { label: 'Sin fecha', count: undated.length, empty: 'No hay tareas de Aula Virtual pendientes sin fecha.', tasks: undated },
        ...(completed.length > 0 ? [{
          label: 'Completadas',
          count: completed.length,
          empty: 'No hay tareas confirmadas.',
          tasks: completed,
        }] : []),
      ];
    }
    if (activeView === 'notas') {
      const upcoming = sortedNotes.filter((item) => item.deadline !== null && !item.completed);
      const undated = sortedNotes.filter((item) => item.deadline === null && !item.completed);
      const completed = sortedNotes.filter((item) => item.completed);
      return [
        { label: 'Próximas', count: upcoming.length, empty: 'No tienes notas pendientes con fecha.', tasks: upcoming },
        { label: 'Sin fecha', count: undated.length, empty: 'No tienes notas pendientes sin fecha.', tasks: undated },
        ...(completed.length > 0 ? [{
          label: 'Completadas',
          count: completed.length,
          empty: 'No tienes notas completadas.',
          tasks: completed,
        }] : []),
      ];
    }
    if (activeView === 'completadas') {
      return [
        {
          label: 'Completadas',
          count: completedArchive.length,
          empty: 'Aún no tienes notas completadas ni entregas confirmadas.',
          tasks: completedArchive,
        },
      ];
    }
    const upcoming = combined.filter((item) => item.deadline !== null && !item.completed);
    const undated = combined.filter((item) => item.deadline === null && !item.completed);
    const completed = combined.filter((item) => item.completed);
    return [
      { label: 'Próximas', count: upcoming.length, empty: 'No hay tareas ni notas próximas.', tasks: upcoming },
      { label: 'Sin fecha', count: undated.length, empty: 'No hay tareas ni notas sin fecha.', tasks: undated },
      ...(completed.length > 0 ? [{
        label: 'Completadas',
        count: completed.length,
        empty: 'No hay elementos completados.',
        tasks: completed,
      }] : []),
    ];
  }

  private buildViewMeta(
    activeView: AgendaViewMode,
    isEmpty: boolean,
    session: ReturnType<typeof presentSession>,
  ) {
    if (activeView === 'tareas') {
      return {
        mode: activeView,
        pageTitle: 'Tareas DUTIC · Aula Virtual',
        heading: 'Tareas DUTIC',
        subtitle: 'Actividades sincronizadas de Aula Virtual con estado de PDF y entrega.',
        isAll: false,
        isTasks: true,
        isNotes: false,
        isCompleted: false,
        showFilters: true,
        emptyTitle: 'Sin tareas de Aula Virtual todavía',
        emptyDescription: session?.isDisconnected
          ? 'Conecta tu sesión de Aula Virtual y ejecuta una búsqueda para traer tus actividades y fechas de entrega.'
          : 'Ejecuta una búsqueda para sincronizar tus tareas vigentes desde Aula Virtual.',
        emptyActionHref: session?.isDisconnected ? '/sesion' : null,
        emptyActionLabel: session?.isDisconnected ? 'Ir a Sesión DUTIC' : null,
        isEmpty,
      };
    }
    if (activeView === 'notas') {
      return {
        mode: activeView,
        pageTitle: 'Mis Notas · Aula Virtual',
        heading: 'Mis Notas',
        subtitle: 'Pendientes personales, repasos y prioridades organizados en tu espacio local.',
        isAll: false,
        isTasks: false,
        isNotes: true,
        isCompleted: false,
        showFilters: true,
        emptyTitle: 'Aún no has creado notas personales',
        emptyDescription: 'Registra lecturas, exámenes o entregas fuera de Aula Virtual con prioridad y fecha límite.',
        emptyActionHref: this.notes ? '/notas/nueva' : null,
        emptyActionLabel: this.notes ? 'Crear primera nota' : null,
        isEmpty,
      };
    }
    if (activeView === 'completadas') {
      return {
        mode: activeView,
        pageTitle: 'Completadas · Aula Virtual',
        heading: 'Completadas',
        subtitle: 'Archivo de notas finalizadas y entregas confirmadas en Aula Virtual.',
        isAll: false,
        isTasks: false,
        isNotes: false,
        isCompleted: true,
        showFilters: false,
        emptyTitle: 'Sin elementos completados aún',
        emptyDescription: 'Cuando marques una nota como completada o confirmes una entrega en Aula Virtual aparecerá aquí.',
        emptyActionHref: '/',
        emptyActionLabel: 'Volver a la agenda',
        isEmpty,
      };
    }
    return {
      mode: activeView,
      pageTitle: 'Agenda · Aula Virtual',
      heading: 'Agenda',
      subtitle: 'Tareas de Aula Virtual y notas personales ordenadas por plazo.',
      isAll: true,
      isTasks: false,
      isNotes: false,
      isCompleted: false,
      showFilters: true,
      emptyTitle: 'Tu agenda está lista',
      emptyDescription: this.assisted
        ? 'Importa tus tareas desde Codex o crea una nota personal para comenzar a ordenar tus plazos.'
        : 'Sincroniza tus tareas de Aula Virtual o crea una nota personal para empezar a seguir tus plazos.',
      emptyActionHref: this.notes ? '/notas/nueva' : null,
      emptyActionLabel: this.notes ? 'Nueva nota' : null,
      isEmpty,
    };
  }

  private async readJob(jobId: string) {
    const accountId = currentAccount(this.account);
    try {
      return await this.status.execute(accountId, jobId);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'not_found') throw new NotFoundException(error.message);
      throw error;
    }
  }
}
