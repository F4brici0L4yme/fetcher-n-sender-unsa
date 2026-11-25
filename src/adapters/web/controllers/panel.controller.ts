import {
  Body, ConflictException, Controller, Get, Header, Inject, NotFoundException, Optional, Param, ParseUUIDPipe, PayloadTooLargeException, Post, Query, Redirect, Render, Res,
  Sse, UploadedFile, UseFilters, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  BuscarTareas, CargarPdf, ConsultarTrabajo, ConsultarUltimaBusqueda, ListarTareas, MAX_PDF_BYTES, SolicitarEntrega,
} from '../../../core/application/tasks';
import { ApplicationError } from '../../../core/domain/model';
import { PanelAssistedCapture } from '../panel-assisted-capture';
import { presentJob, presentTask } from '../panel.presenter';
import { PANEL_ACCOUNT, PANEL_DEMO } from '../panel.tokens';
import { PanelWriteGuard } from '../panel-write.guard';
import { PdfUploadErrorFilter } from './pdf-upload.filter';
import { TaskPage } from './task-page';

@Controller()
@UseGuards(PanelWriteGuard)
export class PanelController {
  constructor(
    @Inject(PANEL_ACCOUNT) private readonly accountId: string,
    @Inject(PANEL_DEMO) private readonly demoMode: boolean,
    private readonly search: BuscarTareas,
    private readonly list: ListarTareas,
    private readonly loadPdf: CargarPdf,
    private readonly send: SolicitarEntrega,
    private readonly status: ConsultarTrabajo,
    private readonly latest: ConsultarUltimaBusqueda,
    private readonly taskPage: TaskPage,
    @Optional() private readonly assisted?: PanelAssistedCapture,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('panel-index')
  async index(@Query('job', new ParseUUIDPipe({ optional: true })) jobId?: string) {
    // Read the marker first so a commit between queries still triggers an update.
    const captureRevision = await this.assisted?.currentRevision();
    const [tasks, job] = await Promise.all([
      this.list.execute(this.accountId),
      jobId && !this.assisted ? this.readJob(jobId) : this.latest.execute(this.accountId),
    ]);
    const presented = tasks.map((task) => presentTask(task, this.demoMode));
    return {
      demoMode: this.demoMode,
      assistedCapture: this.assisted ? { ready: this.assisted.ready, revision: captureRevision ?? '' } : null,
      groups: [
        { label: 'Próximas', empty: 'No hay tareas próximas.', tasks: presented.filter((task) => task.deadline !== null) },
        { label: 'Sin fecha', empty: 'No hay tareas sin fecha.', tasks: presented.filter((task) => task.deadline === null) },
      ],
      job: job?.kind === 'search' ? presentJob(job, this.demoMode) : null,
    };
  }

  @Sse('eventos/tareas')
  changes() {
    if (!this.assisted) throw new NotFoundException();
    return this.assisted.watch();
  }

  @Post('busquedas')
  @Redirect('/', 303)
  async queueSearch() {
    if (this.assisted) throw new ConflictException('Inicia la captura desde el chat de Codex.');
    const { jobId } = await this.search.execute(this.accountId);
    return { url: '/?job=' + jobId };
  }

  @Get('tareas/:taskId')
  @Render('panel-task')
  task(@Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.taskPage.view(taskId);
  }

  @Post('tareas/:taskId/pdf')
  @UseInterceptors(FileInterceptor('pdf', { limits: { files: 1, fields: 0, fileSize: MAX_PDF_BYTES + 1 } }))
  @UseFilters(PdfUploadErrorFilter)
  async upload(@Param('taskId', ParseUUIDPipe) taskId: string, @Res() response: Response, @UploadedFile() file?: Express.Multer.File) {
    if (this.assisted) throw new ConflictException('La captura asistida solo registra tareas.');
    if (file && file.size > MAX_PDF_BYTES) throw new PayloadTooLargeException();
    try {
      if (!file) throw new ApplicationError('invalid_pdf', 'Selecciona un PDF.');
      await this.loadPdf.execute({
        accountId: this.accountId, taskId, originalName: file.originalname, content: file.buffer,
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
  async authorize(@Param('taskId', ParseUUIDPipe) taskId: string, @Body('pdfId', ParseUUIDPipe) pdfId: string, @Res() response: Response) {
    if (this.assisted) throw new ConflictException('La captura asistida solo registra tareas.');
    try {
      await this.send.execute({ accountId: this.accountId, taskId, pdfId });
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      if (error.code === 'not_found') throw new NotFoundException(error.message);
      if (!['stale_pdf', 'unsupported_destination', 'delivery_pending'].includes(error.code)) throw error;
      response.status(409).render('panel-task', await this.taskPage.view(taskId, { deliveryError: error.message }));
      return;
    }
    response.redirect(303, '/tareas/' + taskId);
  }

  @Get('trabajos/:jobId')
  async job(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return presentJob(await this.readJob(jobId), this.demoMode);
  }

  private async readJob(jobId: string) {
    try {
      return await this.status.execute(this.accountId, jobId);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'not_found') throw new NotFoundException(error.message);
      throw error;
    }
  }
}
