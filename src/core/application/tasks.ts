import { compareDeadline, visibleDeadline } from '../domain/deadline';
import { ApplicationError, PdfSummary } from '../domain/model';
import { JobRepository, PdfStore, SearchHistory, TaskRepository } from './ports/persistence';

export const MAX_PDF_BYTES = 20 * 1024 * 1024;

const decoder = new TextDecoder('ascii');

export class BuscarTareas {
  constructor(private readonly jobs: JobRepository) {}

  async execute(accountId: string) {
    return { jobId: await this.jobs.queueSearch(accountId) };
  }
}

export class ListarTareas {
  constructor(private readonly tasks: TaskRepository, private readonly clock = () => new Date()) {}

  async execute(accountId: string) {
    const now = this.clock();
    return (await this.tasks.list(accountId))
      .filter((task) => visibleDeadline(task.deadline, now)).sort(compareDeadline);
  }
}

export class VerTarea {
  constructor(private readonly tasks: TaskRepository) {}

  async execute(accountId: string, taskId: string) {
    const task = await this.tasks.find(accountId, taskId);
    if (!task) throw new ApplicationError('not_found', 'La tarea no existe.');
    return task;
  }
}

export class CargarPdf {
  constructor(private readonly tasks: TaskRepository, private readonly files: PdfStore) {}

  async execute(input: {
    accountId: string; taskId: string; originalName: string; content: Uint8Array;
  }): Promise<PdfSummary> {
    const { accountId, taskId, originalName, content } = input;
    if (content.byteLength < 14 || content.byteLength > MAX_PDF_BYTES) {
      throw new ApplicationError('invalid_pdf', 'Carga un PDF válido de hasta 20 MiB.');
    }
    if (originalName.length > 255 || !originalName.trim()
      || Array.from(originalName).some((character) =>
        character === '/' || character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || !/^%PDF-[12]\.\d(?:\r|\n)/.test(decoder.decode(content.subarray(0, 10)))
      || !decoder.decode(content.subarray(-1024)).trimEnd().endsWith('%%EOF')) {
      throw new ApplicationError('invalid_pdf', 'El archivo o su nombre no es un PDF válido.');
    }

    const pdf = await this.files.write(content);
    try {
      await this.tasks.attachPdf(accountId, taskId, { ...pdf, originalName });
    } catch (error) {
      // A transport failure can leave the database commit uncertain. In that case preserve the file.
      if (error instanceof ApplicationError) await this.files.discard(pdf.storageKey);
      throw error;
    }
    return { pdfId: pdf.pdfId, originalName, sha256: pdf.sha256 };
  }
}

export class SolicitarEntrega {
  constructor(private readonly jobs: JobRepository) {}

  async execute(input: { accountId: string; taskId: string; pdfId: string }) {
    return { jobId: await this.jobs.authorizeDelivery(input.accountId, input.taskId, input.pdfId) };
  }
}

export class ConsultarUltimaBusqueda {
  constructor(private readonly history: SearchHistory) {}

  execute(accountId: string) {
    return this.history.latestSearch(accountId);
  }
}

export class ConsultarTrabajo {
  constructor(private readonly jobs: JobRepository) {}

  async execute(accountId: string, jobId: string) {
    const job = await this.jobs.find(accountId, jobId);
    if (!job) throw new ApplicationError('not_found', 'El trabajo no existe.');
    return job;
  }
}

export class VerificarEntrega {
  constructor(private readonly jobs: JobRepository) {}

  async execute(accountId: string, jobId: string) {
    await this.jobs.requestVerification(accountId, jobId);
    return { jobId };
  }
}
