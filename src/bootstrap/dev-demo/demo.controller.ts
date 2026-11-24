import {
  BadRequestException, Body, Controller, Get, HttpException, Inject, Param, ParseUUIDPipe, Post, Query,
  Redirect, Render, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  BuscarTareas, CargarPdf, ConsultarTrabajo, ListarTareas, MAX_PDF_BYTES, SolicitarEntrega, VerificarEntrega, VerTarea,
} from '../../core/application/tasks';
import { ApplicationError, JobView } from '../../core/domain/model';
import { ACCOUNT_ID } from '../core.module';

const labels = {
  queued: 'En cola', running: 'En ejecución', completed: 'Búsqueda completada', failed: 'Error',
  authorized: 'Autorizada', confirmed: 'Entrega simulada confirmada', needs_verification: 'Por verificar',
};

function jobDetails(job: JobView) {
  return {
    ...job, label: labels[job.state],
    refreshing: ['queued', 'running', 'authorized'].includes(job.state),
  };
}

@Controller('__demo')
export class DemoController {
  constructor(
    @Inject(ACCOUNT_ID) private readonly accountId: string,
    private readonly search: BuscarTareas,
    private readonly list: ListarTareas,
    private readonly detail: VerTarea,
    private readonly upload: CargarPdf,
    private readonly send: SolicitarEntrega,
    private readonly status: ConsultarTrabajo,
    private readonly verify: VerificarEntrega,
  ) {}

  @Get()
  @Render('index')
  async index(@Query('job', new ParseUUIDPipe({ optional: true })) jobId?: string) {
    const job = jobId ? await this.run(() => this.status.execute(this.accountId, jobId)) : null;
    return { tasks: await this.list.execute(this.accountId), job: job ? jobDetails(job) : null };
  }

  @Post('search')
  @Redirect('/__demo', 303)
  async startSearch() {
    const { jobId } = await this.search.execute(this.accountId);
    return { url: '/__demo?job=' + jobId };
  }

  @Get('tasks/:taskId')
  @Render('task')
  async task(@Param('taskId', ParseUUIDPipe) taskId: string) {
    const task = await this.run(() => this.detail.execute(this.accountId, taskId));
    const delivery = task.delivery ? jobDetails(task.delivery) : null;
    return {
      ...task, delivery, uncertain: delivery?.state === 'needs_verification',
      canDeliver: task.destination === 'aula_virtual' && task.currentPdf
        && !['authorized', 'running', 'needs_verification'].includes(delivery?.state ?? ''),
    };
  }

  @Post('tasks/:taskId/pdf')
  @UseInterceptors(FileInterceptor('pdf', { limits: { fileSize: MAX_PDF_BYTES + 1, files: 1 } }))
  @Redirect('/__demo', 303)
  async receivePdf(@Param('taskId', ParseUUIDPipe) taskId: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Selecciona un PDF.');
    await this.run(() => this.upload.execute({
      accountId: this.accountId, taskId, originalName: file.originalname, content: file.buffer,
    }));
    return { url: '/__demo/tasks/' + taskId };
  }

  @Post('tasks/:taskId/deliver')
  @Redirect('/__demo', 303)
  async deliver(@Param('taskId', ParseUUIDPipe) taskId: string, @Body('pdfId', ParseUUIDPipe) pdfId: string) {
    await this.run(() => this.send.execute({ accountId: this.accountId, taskId, pdfId }));
    return { url: '/__demo/tasks/' + taskId };
  }

  @Post('tasks/:taskId/verify')
  @Redirect('/__demo', 303)
  async verifyDelivery(@Param('taskId', ParseUUIDPipe) taskId: string) {
    const task = await this.run(() => this.detail.execute(this.accountId, taskId));
    if (!task.delivery) throw new BadRequestException('Todavía no hay una entrega.');
    const { jobId } = task.delivery;
    await this.run(() => this.verify.execute(this.accountId, jobId));
    return { url: '/__demo/tasks/' + taskId };
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      const status = error.code === 'not_found' ? 404 : error.code === 'invalid_pdf' ? 400 : 409;
      throw new HttpException(error.message, status);
    }
  }
}
