import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TaskPage } from './task-page';

@Catch(BadRequestException, PayloadTooLargeException)
export class PdfUploadErrorFilter implements ExceptionFilter {
  constructor(private readonly taskPage: TaskPage) {}

  async catch(error: BadRequestException | PayloadTooLargeException, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const taskId = http.getRequest<Request<{ taskId: string }>>().params.taskId;
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(taskId)) {
      response.status(400).send('Identificador de tarea inválido.');
      return;
    }

    const uploadError = error.getStatus() === 413
      ? 'El PDF supera el límite de 20 MiB.'
      : 'Selecciona un único PDF para cargar.';
    try {
      response.status(error.getStatus()).render('panel-task', await this.taskPage.view(taskId, { uploadError }));
    } catch (renderError) {
      if (renderError instanceof NotFoundException) response.status(404).send('La tarea no existe.');
      else response.status(500).send('No se pudo abrir la tarea.');
    }
  }
}
