import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Header, HttpCode, Inject,
  NotFoundException, Optional, Param, ParseUUIDPipe, PayloadTooLargeException, Post, Query,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  AnalizarComandoEntrega, AutorizarPropuestaAgente, ListarPropuestasAgente,
  PoliticaAutomatizacion, PrepararEntregaAgente, RechazarPropuestaAgente,
} from '../../../core/application/agent';
import { PersonalNotes } from '../../../core/application/notes';
import { AUTO_SYNC_MONITOR, type AutoSyncMonitor } from '../../../core/application/ports/agent';
import { PERSONAL_SESSION, type PersonalSession } from '../../../core/application/ports/browser-session';
import {
  BuscarTareas, ConsultarTrabajo, DescartarIntentoEntrega, ListarTareas, MAX_PDF_BYTES,
} from '../../../core/application/tasks';
import { matchTasksForCommand } from '../../../core/domain/command-matcher';
import { ApplicationError } from '../../../core/domain/model';
import { NoteValidationError } from '../../../core/domain/personal-note';
import { currentAccount, type PanelAccount } from '../panel-account';
import { PanelAssistedCapture } from '../panel-assisted-capture';
import { presentJob } from '../panel.presenter';
import { PANEL_ACCOUNT, PANEL_DEMO } from '../panel.tokens';
import { PanelWriteGuard } from '../panel-write.guard';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readStringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readBooleanField(body: unknown, key: string): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const value = (body as Record<string, unknown>)[key];
  return value === true || value === 'true' || value === '1';
}

@Controller('api/agente')
@UseGuards(PanelWriteGuard)
export class AgentApiController {
  constructor(
    @Inject(PANEL_ACCOUNT) private readonly account: PanelAccount,
    @Inject(PANEL_DEMO) private readonly demoMode: boolean,
    private readonly search: BuscarTareas,
    private readonly list: ListarTareas,
    private readonly statusUseCase: ConsultarTrabajo,
    @Optional() private readonly assisted?: PanelAssistedCapture,
    @Optional() private readonly notes?: PersonalNotes,
    @Optional() @Inject(PERSONAL_SESSION) private readonly session?: PersonalSession,
    @Optional() @Inject(AUTO_SYNC_MONITOR) private readonly autoSync?: AutoSyncMonitor,
    @Optional() private readonly policy?: PoliticaAutomatizacion,
    @Optional() private readonly proposals?: ListarPropuestasAgente,
    @Optional() private readonly analyze?: AnalizarComandoEntrega,
    @Optional() private readonly prepare?: PrepararEntregaAgente,
    @Optional() private readonly authorize?: AutorizarPropuestaAgente,
    @Optional() private readonly reject?: RechazarPropuestaAgente,
    @Optional() private readonly discardDelivery?: DescartarIntentoEntrega,
  ) {}

  @Get('estado')
  @Header('Cache-Control', 'no-store')
  async state() {
    const accountId = currentAccount(this.account);
    const [tasks, noteList, sessionStatus, deliveryPolicy, proposalList] = await Promise.all([
      this.list.execute(accountId),
      this.notes ? this.notes.list(accountId) : Promise.resolve([]),
      this.session ? this.session.status() : Promise.resolve(null),
      this.policy ? this.policy.get(accountId) : Promise.resolve('confirm_in_panel' as const),
      this.proposals ? this.proposals.execute(accountId, 50) : Promise.resolve([]),
    ]);
    const completedTasks = tasks.filter((t) => t.delivery?.state === 'confirmed').length;
    return {
      accountId,
      session: sessionStatus
        ? { state: sessionStatus.state, busy: sessionStatus.busy, message: sessionStatus.message }
        : null,
      policy: deliveryPolicy,
      autoSync: this.autoSync?.status() ?? {
        enabled: false, intervalSeconds: 0, lastSyncAt: null, nextSyncAt: null, running: false,
      },
      counts: {
        pendingTasks: tasks.length - completedTasks,
        completedTasks,
        pendingProposals: proposalList.filter((p) => p.state === 'pending').length,
        pendingNotes: noteList.filter((n) => n.status !== 'completado').length,
      },
    };
  }

  @Get('tareas')
  @Header('Cache-Control', 'no-store')
  async tasks(@Query('q') query?: string) {
    const accountId = currentAccount(this.account);
    const tasks = await this.list.execute(accountId);
    if (query && query.trim()) {
      const matched = matchTasksForCommand(tasks, query);
      return {
        accountId,
        tasks,
        match: {
          kind: matched.kind,
          pdfHint: matched.pdfHint,
          candidates: matched.candidates,
        },
      };
    }
    return { accountId, tasks };
  }

  @Post('analizar')
  @HttpCode(200)
  async analyzeCommand(@Body() body: unknown) {
    const accountId = currentAccount(this.account);
    const instruction = readStringField(body, 'instruction') ?? '';
    if (this.analyze) {
      return this.analyze.execute(accountId, instruction);
    }
    const tasks = await this.list.execute(accountId);
    return matchTasksForCommand(tasks, instruction);
  }

  @Post('sincronizar')
  @HttpCode(202)
  async sync() {
    if (this.assisted) throw new ConflictException('Inicia la captura desde el chat de Codex.');
    const accountId = currentAccount(this.account);
    return this.search.execute(accountId);
  }

  @Post('entregas')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('pdf', { limits: { files: 1, fields: 8, fileSize: MAX_PDF_BYTES + 1 } }))
  async prepareDelivery(@Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (this.assisted) throw new ConflictException('La captura asistida solo registra tareas.');
    if (!this.prepare) throw new NotFoundException('La automatización del agente no está habilitada.');
    if (!file) throw new BadRequestException('Adjunta un archivo PDF válido.');
    if (file.size > MAX_PDF_BYTES) throw new PayloadTooLargeException('El PDF supera el límite de 20 MiB.');

    const accountId = currentAccount(this.account);
    const instruction = readStringField(body, 'instruction') ?? '';
    const rawTaskId = readStringField(body, 'taskId')?.trim();
    if (rawTaskId && !UUID_PATTERN.test(rawTaskId)) {
      throw new BadRequestException('El identificador de tarea es inválido.');
    }
    const source = readStringField(body, 'source') ?? 'ai-mcp';
    const allowDirectExecution = readBooleanField(body, 'executeIfAllowed');

    try {
      const result = await this.prepare.execute({
        accountId,
        instruction,
        taskId: rawTaskId || undefined,
        originalName: file.originalname,
        content: file.buffer,
        source,
        allowDirectExecution,
      });
      return {
        ...result,
        panelUrl: '/agente',
      };
    } catch (error) {
      this.rethrowApplicationError(error);
    }
  }

  @Post('propuestas/:proposalId/autorizar')
  @HttpCode(200)
  async authorizeProposal(@Param('proposalId', ParseUUIDPipe) proposalId: string) {
    if (!this.authorize) throw new NotFoundException('La automatización del agente no está habilitada.');
    const accountId = currentAccount(this.account);
    try {
      return await this.authorize.execute(accountId, proposalId);
    } catch (error) {
      this.rethrowApplicationError(error);
    }
  }

  @Post('propuestas/:proposalId/rechazar')
  @HttpCode(200)
  async rejectProposal(@Param('proposalId', ParseUUIDPipe) proposalId: string) {
    if (!this.reject) throw new NotFoundException('La automatización del agente no está habilitada.');
    const accountId = currentAccount(this.account);
    try {
      return { proposal: await this.reject.execute(accountId, proposalId) };
    } catch (error) {
      this.rethrowApplicationError(error);
    }
  }

  @Post('politica')
  @HttpCode(200)
  async updatePolicy(@Body() body: unknown) {
    if (!this.policy) throw new NotFoundException('La automatización del agente no está habilitada.');
    const accountId = currentAccount(this.account);
    try {
      const policy = await this.policy.set(accountId, readStringField(body, 'policy'));
      return { accountId, policy };
    } catch (error) {
      this.rethrowApplicationError(error);
    }
  }

  @Get('trabajos/:jobId')
  @Header('Cache-Control', 'no-store')
  async job(@Param('jobId', ParseUUIDPipe) jobId: string) {
    const accountId = currentAccount(this.account);
    try {
      const job = await this.statusUseCase.execute(accountId, jobId);
      const presented = presentJob(job, this.demoMode)!;
      return {
        jobId: presented.jobId,
        kind: presented.kind,
        state: presented.state,
        label: presented.label,
        active: presented.active,
        summary: presented.summary,
        evidence: presented.kind === 'delivery' ? presented.evidence : null,
        proofUrl: presented.proofUrl,
      };
    } catch (error) {
      this.rethrowApplicationError(error);
    }
  }

  @Get('notas')
  @Header('Cache-Control', 'no-store')
  async listNotes() {
    if (!this.notes) throw new NotFoundException('Las notas personales no están habilitadas.');
    const accountId = currentAccount(this.account);
    return { accountId, notes: await this.notes.list(accountId) };
  }

  @Post('notas')
  @HttpCode(201)
  async createNote(@Body() body: unknown) {
    if (!this.notes) throw new NotFoundException('Las notas personales no están habilitadas.');
    const accountId = currentAccount(this.account);
    try {
      return { note: await this.notes.create(accountId, body) };
    } catch (error) {
      if (error instanceof NoteValidationError) throw new BadRequestException(error.message);
      this.rethrowApplicationError(error);
    }
  }

  @Delete('tareas/:taskId/entregas/:jobId')
  @HttpCode(200)
  async deleteDeliveryAttempt(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    if (this.assisted) throw new ConflictException('La captura asistida solo registra tareas.');
    if (!this.discardDelivery) throw new NotFoundException('El descarte de intentos no está habilitado.');
    const accountId = currentAccount(this.account);
    try {
      return await this.discardDelivery.execute(accountId, taskId, jobId);
    } catch (error) {
      this.rethrowApplicationError(error);
    }
  }

  private rethrowApplicationError(error: unknown): never {
    if (error instanceof ApplicationError) {
      if (error.code === 'not_found') throw new NotFoundException(error.message);
      if (error.code === 'invalid_pdf' || error.code === 'invalid_policy') throw new BadRequestException(error.message);
      if (['stale_pdf', 'unsupported_destination', 'delivery_pending', 'proposal_not_pending', 'delivery_confirmed', 'delivery_active'].includes(error.code)) {
        throw new ConflictException(error.message);
      }
    }
    throw error;
  }
}
