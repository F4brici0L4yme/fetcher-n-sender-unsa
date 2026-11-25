import { isDateOnly } from '../../core/domain/deadline';
import { JobView, TaskView } from '../../core/domain/model';

const labels = {
  queued: 'En cola', running: 'En ejecución', completed: 'Búsqueda completada', failed: 'Error',
  authorized: 'Autorizada', confirmed: 'Entrega confirmada', needs_verification: 'Por verificar',
};

const destinations = { aula_virtual: 'Aula Virtual', other: 'Canal externo', unknown: 'Destino sin confirmar' };
const dateFormatter = new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', dateStyle: 'long' });
const instantFormatter = new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima', dateStyle: 'long', timeStyle: 'short',
});

export function presentJob(job: JobView | null, demoMode: boolean) {
  if (!job) return null;
  return {
    ...job,
    detail: job.state === 'confirmed' && job.summary === 'Entrega confirmada.' ? null : job.summary,
    label: demoMode && job.state === 'confirmed' ? 'Entrega simulada confirmada' : labels[job.state],
    active: job.state === 'queued' || job.state === 'running' || job.state === 'authorized',
  };
}

export function presentTask(task: TaskView, demoMode: boolean) {
  const deadlineLabel = task.deadline
    ? (isDateOnly(task.deadline) ? dateFormatter : instantFormatter).format(new Date(task.deadline))
    : 'Sin fecha';

  let deliverDisabledReason: string | undefined;
  if (task.delivery?.state === 'needs_verification') {
    deliverDisabledReason = 'El resultado está por verificar. Revisa Aula Virtual antes de volver a enviar.';
  } else if (task.delivery?.state === 'authorized' || task.delivery?.state === 'running') {
    deliverDisabledReason = 'Hay un intento de entrega en curso.';
  } else if (task.destination !== 'aula_virtual') {
    deliverDisabledReason = task.destination === 'other'
      ? 'Esta tarea indica un canal de entrega externo.'
      : 'Aún no se ha confirmado el canal de entrega.';
  } else if (!task.currentPdf) {
    deliverDisabledReason = 'Carga un PDF para habilitar la entrega.';
  } else if (task.delivery?.pdfId === task.currentPdf.pdfId) {
    if (task.delivery.state === 'confirmed') deliverDisabledReason = 'Este PDF ya está entregado.';
    if (task.delivery.state === 'failed') deliverDisabledReason = 'Carga el PDF de nuevo para autorizar otro intento.';
  }

  const url = URL.parse(task.activityUrl);
  const destinationUrl = url?.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  return {
    ...task, deadlineLabel, destinationUrl, destinationLabel: destinations[task.destination],
    delivery: presentJob(task.delivery, demoMode), deliverDisabledReason,
  };
}
