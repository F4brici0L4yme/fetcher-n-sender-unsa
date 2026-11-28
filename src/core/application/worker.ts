import { normalizeDeadline, visibleDeadline } from '../domain/deadline';
import { ApplicationError, CapturedAssignment, DeliveryResult, StoredDeliveryOrder } from '../domain/model';
import { AssignmentFetcher, AssignmentSender } from './ports/academic';
import { PdfStore, WorkerRepository, WorkerSession } from './ports/persistence';

const captureErrors = {
  session_expired: 'Inicia sesión de nuevo en Aula Virtual.',
  unavailable: 'El navegador de Aula Virtual no está configurado.',
  failed: 'No se pudieron consultar las tareas.',
};

function parseAssignment(item: CapturedAssignment): CapturedAssignment {
  if (!item || [item.externalId, item.course, item.title, item.activityUrl].some(
    (value) => typeof value !== 'string' || !value.trim() || value.includes(String.fromCharCode(0)),
  ) || !['aula_virtual', 'other', 'unknown'].includes(item.destination)) {
    throw new ApplicationError('invalid_capture', 'La captura contiene datos inválidos.');
  }
  const url = URL.parse(item.activityUrl);
  if (!url || url.protocol !== 'https:' || url.username || url.password) {
    throw new ApplicationError('invalid_capture', 'La captura contiene una URL de actividad inválida.');
  }
  return {
    externalId: item.externalId.trim(), course: item.course.trim(), title: item.title.trim(),
    activityUrl: url.href, deadline: normalizeDeadline(item.deadline), destination: item.destination,
  };
}

function identifiesOrder(result: DeliveryResult, order: StoredDeliveryOrder): boolean {
  return result.state === 'confirmed'
    && URL.parse(result.evidence?.activityUrl ?? '')?.href === order.activityUrl
    && result.evidence.fileName === order.originalName
    && Boolean(result.evidence.visibleStatus?.trim());
}

export class AcademicWorker {
  constructor(
    private readonly repository: WorkerRepository,
    private readonly fetcher: AssignmentFetcher,
    private readonly sender: AssignmentSender,
    private readonly files: PdfStore,
    private readonly clock = () => new Date(),
  ) {}

  async tick(accountId: string): Promise<void> {
    await this.repository.withAccountLock(accountId, async (session) => {
      await session.recoverInterrupted();
      const work = await session.claimNext();
      if (!work) return;
      if (work.kind === 'search') {
        await this.search(session, accountId, work.jobId);
        return;
      }
      await this.deliver(session, work.order, work.kind === 'verification');
    });
  }

  private async search(session: WorkerSession, accountId: string, jobId: string) {
    let assignments: CapturedAssignment[];
    try {
      const result = await this.fetcher.fetch({ accountId, jobId });
      if (result.kind !== 'success') {
        await session.failSearch(jobId, captureErrors[result.kind]);
        return;
      }
      const now = this.clock();
      assignments = result.assignments.map(parseAssignment)
        .filter(({ deadline }) => visibleDeadline(deadline, now));
    } catch (error) {
      await session.failSearch(jobId, error instanceof ApplicationError ? error.message : captureErrors.failed);
      return;
    }
    await session.completeSearch(jobId, assignments);
  }

  private async deliver(session: WorkerSession, order: StoredDeliveryOrder, verification: boolean) {
    const expected = verification ? 'needs_verification' : 'running';
    let localFilePath: string;
    try {
      localFilePath = verification ? this.files.path(order.storageKey)
        : await this.files.verifiedPath(order.storageKey, order.sha256);
    } catch {
      await session.settleDelivery(order.jobId, expected, verification ? 'needs_verification' : 'failed',
        'No se pudo acceder al PDF autorizado o cambió su contenido.');
      return;
    }
    const { storageKey: _storageKey, ...details } = order;
    const portalOrder = { ...details, localFilePath };
    let result: DeliveryResult;
    try {
      result = verification ? await this.sender.verify(portalOrder) : await this.sender.submit(portalOrder);
    } catch {
      await session.settleDelivery(order.jobId, expected, 'needs_verification',
        'Comprueba el resultado en Aula Virtual antes de volver a enviar.');
      return;
    }

    if (identifiesOrder(result, order)) {
      await session.settleDelivery(order.jobId, expected, 'confirmed', 'Entrega confirmada.', result.evidence);
    } else if (result.state === 'failed') {
      const summary = verification
        ? 'DUTIC confirmó que todavía no hay ningún envío registrado. Puedes volver a intentar.'
        : 'El portal no confirmó ningún envío.';
      await session.settleDelivery(order.jobId, expected, 'failed', summary, result.evidence);
    } else {
      await session.settleDelivery(order.jobId, expected, 'needs_verification',
        'La evidencia del portal todavía no confirma el envío.', result.evidence);
    }
  }
}
