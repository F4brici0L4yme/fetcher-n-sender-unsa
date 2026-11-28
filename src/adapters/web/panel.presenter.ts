import { type AgentDeliveryPolicy, type AgentDeliveryProposal, type AutoSyncStatus } from '../../core/domain/agent-automation';
import { BrowserSessionStatus } from '../../core/domain/browser-session';
import { isDateOnly } from '../../core/domain/deadline';
import { JobView, TaskView } from '../../core/domain/model';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';
export type SidebarSection = 'agenda' | 'tareas' | 'notas' | 'completadas' | 'agente' | 'sesion';

const labels = {
  queued: 'En cola', running: 'En ejecución', completed: 'Búsqueda completada', failed: 'Error',
  authorized: 'Autorizada', confirmed: 'Entrega confirmada', needs_verification: 'Por verificar',
};

const jobTones: Record<JobView['state'], BadgeTone> = {
  queued: 'warning',
  running: 'warning',
  completed: 'success',
  failed: 'danger',
  authorized: 'warning',
  confirmed: 'success',
  needs_verification: 'warning',
};

const sessionLabels: Record<BrowserSessionStatus['state'], string> = {
  disconnected: 'Desconectada',
  connecting: 'Conectando',
  connected: 'Conectada',
  expired: 'Vencida',
  error: 'Error',
};

const sessionTones: Record<BrowserSessionStatus['state'], BadgeTone> = {
  disconnected: 'neutral',
  connecting: 'warning',
  connected: 'success',
  expired: 'danger',
  error: 'danger',
};

const proposalLabels: Record<AgentDeliveryProposal['state'], string> = {
  pending: 'Pendiente de confirmación',
  authorized: 'Autorizada',
  rejected: 'Rechazada',
};

const proposalTones: Record<AgentDeliveryProposal['state'], BadgeTone> = {
  pending: 'warning',
  authorized: 'success',
  rejected: 'neutral',
};

const sourceLabels: Record<string, string> = {
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

const destinations = { aula_virtual: 'Aula Virtual', other: 'Canal externo', unknown: 'Destino sin confirmar' };
const dateFormatter = new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const instantFormatter = new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

export interface DeliveryStepView {
  label: string;
  state: 'done' | 'active' | 'warning' | 'danger' | 'pending';
}

function buildDeliveryStepper(delivery: Extract<JobView, { kind: 'delivery' }> | null): DeliveryStepView[] {
  const state = delivery?.state;
  if (!state) {
    return [
      { label: 'Autorizada', state: 'pending' },
      { label: 'En ejecución', state: 'pending' },
      { label: 'Verificada en DUTIC', state: 'pending' },
      { label: 'Confirmada', state: 'pending' },
    ];
  }
  if (state === 'authorized') {
    return [
      { label: 'Autorizada', state: 'active' },
      { label: 'En ejecución', state: 'pending' },
      { label: 'Verificada en DUTIC', state: 'pending' },
      { label: 'Confirmada', state: 'pending' },
    ];
  }
  if (state === 'running') {
    return [
      { label: 'Autorizada', state: 'done' },
      { label: 'En ejecución', state: 'active' },
      { label: 'Verificada en DUTIC', state: 'pending' },
      { label: 'Confirmada', state: 'pending' },
    ];
  }
  if (state === 'needs_verification') {
    return [
      { label: 'Autorizada', state: 'done' },
      { label: 'En ejecución', state: 'done' },
      { label: 'Verificada en DUTIC', state: 'warning' },
      { label: 'Confirmada', state: 'pending' },
    ];
  }
  if (state === 'confirmed') {
    return [
      { label: 'Autorizada', state: 'done' },
      { label: 'En ejecución', state: 'done' },
      { label: 'Verificada en DUTIC', state: 'done' },
      { label: 'Confirmada', state: 'done' },
    ];
  }
  return [
    { label: 'Autorizada', state: 'done' },
    { label: 'En ejecución', state: 'danger' },
    { label: 'Verificada en DUTIC', state: 'pending' },
    { label: 'Confirmada', state: 'pending' },
  ];
}

export function formatShortSha256(sha256: string | undefined): string | null {
  if (!sha256) return null;
  if (sha256.length <= 14) return sha256;
  return `${sha256.slice(0, 8)}…${sha256.slice(-4)}`;
}

function formatInstant(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return instantFormatter.format(new Date(parsed));
}

export function presentAutoSync(autoSync: AutoSyncStatus | null | undefined) {
  if (!autoSync || !autoSync.enabled) {
    return {
      enabled: false,
      intervalSeconds: 0,
      intervalLabel: '',
      shortLabel: '',
      lastSyncLabel: null as string | null,
      running: false,
    };
  }
  const minutes = Math.round(autoSync.intervalSeconds / 60);
  const intervalLabel = autoSync.intervalSeconds >= 60 && autoSync.intervalSeconds % 60 === 0
    ? `cada ${minutes} min`
    : `cada ${autoSync.intervalSeconds} s`;
  const shortLabel = autoSync.intervalSeconds >= 60 && autoSync.intervalSeconds % 60 === 0
    ? `Auto-sync ${minutes} min`
    : `Auto-sync ${autoSync.intervalSeconds}s`;
  return {
    enabled: true,
    intervalSeconds: autoSync.intervalSeconds,
    intervalLabel,
    shortLabel,
    lastSyncLabel: formatInstant(autoSync.lastSyncAt),
    running: autoSync.running,
  };
}

export function presentJob(job: JobView | null, demoMode: boolean) {
  if (!job) return null;
  const proofKey = job.kind === 'delivery' ? job.evidence?.proofKey : undefined;
  const capturedAt = job.kind === 'delivery' ? job.evidence?.capturedAt : undefined;
  return {
    ...job,
    detail: job.state === 'confirmed' && job.summary === 'Entrega confirmada.' ? null : job.summary,
    label: demoMode && job.state === 'confirmed' ? 'Entrega simulada confirmada' : labels[job.state],
    tone: jobTones[job.state],
    active: job.state === 'queued' || job.state === 'running' || job.state === 'authorized',
    proofUrl: proofKey ? `/entregas/${job.jobId}/captura` : null,
    proofDownloadUrl: proofKey ? `/entregas/${job.jobId}/captura?download=1` : null,
    capturedAtLabel: formatInstant(capturedAt),
  };
}

export function presentSession(sessionStatus: BrowserSessionStatus | null) {
  if (!sessionStatus) return null;
  return {
    ...sessionStatus,
    stateLabel: sessionLabels[sessionStatus.state],
    tone: sessionTones[sessionStatus.state],
    isDisconnected: sessionStatus.state === 'disconnected' || sessionStatus.state === 'expired' || sessionStatus.state === 'error',
    isConnecting: sessionStatus.state === 'connecting',
    isConnected: sessionStatus.state === 'connected',
    isExpired: sessionStatus.state === 'expired',
    isError: sessionStatus.state === 'error',
    canDisconnect: sessionStatus.state !== 'disconnected',
  };
}

export function presentProposal(proposal: AgentDeliveryProposal) {
  return {
    ...proposal,
    shortSha256: formatShortSha256(proposal.pdfSha256),
    stateLabel: proposalLabels[proposal.state],
    tone: proposalTones[proposal.state],
    sourceLabel: sourceLabels[proposal.source] ?? proposal.source,
    isPending: proposal.state === 'pending',
    isAuthorized: proposal.state === 'authorized',
    isRejected: proposal.state === 'rejected',
    createdAtLabel: formatInstant(proposal.createdAt),
    taskHref: `/tareas/${proposal.taskId}`,
  };
}

export function presentPolicy(policy: AgentDeliveryPolicy) {
  return {
    value: policy,
    isConfirmInPanel: policy === 'confirm_in_panel',
    isDirectOnExactMatch: policy === 'direct_on_exact_match',
    label: policy === 'direct_on_exact_match'
      ? 'Entrega directa del Harness'
      : 'Confirmar en panel (Recomendado)',
  };
}

export interface SidebarOptions {
  active: SidebarSection;
  notesEnabled: boolean;
  agentEnabled?: boolean;
  session: ReturnType<typeof presentSession>;
  autoSync?: ReturnType<typeof presentAutoSync>;
  demoMode?: boolean;
  assistedMode?: boolean;
  liveActive?: boolean;
  counts?: {
    tasks?: number;
    notes?: number;
    completed?: number;
    proposals?: number;
  };
}

export function presentSidebar(options: SidebarOptions) {
  const counts = options.counts ?? {};
  return {
    isAgenda: options.active === 'agenda',
    isTareas: options.active === 'tareas',
    isNotas: options.active === 'notas',
    isCompletadas: options.active === 'completadas',
    isAgente: options.active === 'agente',
    isSesion: options.active === 'sesion',
    notesEnabled: options.notesEnabled,
    agentEnabled: Boolean(options.agentEnabled),
    sessionEnabled: Boolean(options.session),
    session: options.session,
    autoSync: options.autoSync ?? presentAutoSync(null),
    demoMode: Boolean(options.demoMode),
    assistedMode: Boolean(options.assistedMode),
    liveActive: Boolean(options.liveActive),
    hasTaskCount: typeof counts.tasks === 'number',
    taskCount: counts.tasks ?? 0,
    hasNoteCount: typeof counts.notes === 'number',
    noteCount: counts.notes ?? 0,
    hasCompletedCount: typeof counts.completed === 'number',
    completedCount: counts.completed ?? 0,
    hasProposalCount: typeof counts.proposals === 'number' && counts.proposals > 0,
    proposalCount: counts.proposals ?? 0,
  };
}

export function presentTask(task: TaskView, demoMode: boolean) {
  const deadlineLabel = task.deadline
    ? (isDateOnly(task.deadline) ? dateFormatter : instantFormatter).format(new Date(task.deadline))
    : 'Sin fecha';

  let deliverDisabledReason: string | undefined;
  if (task.delivery?.state === 'needs_verification') {
    deliverDisabledReason = 'El resultado está por verificar. Verifica en DUTIC o elimina este intento para volver a intentar.';
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
    if (task.delivery.state === 'failed') deliverDisabledReason = 'Elimina este intento para reintentar con el mismo PDF o carga un archivo nuevo.';
  }

  const url = URL.parse(task.activityUrl);
  const destinationUrl = url?.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  const delivery = presentJob(task.delivery, demoMode);
  const statusLabel = delivery ? delivery.label : (task.currentPdf ? 'PDF listo' : 'PDF pendiente');
  const statusTone: BadgeTone = delivery ? delivery.tone : (task.currentPdf ? 'info' : 'neutral');

  return {
    ...task,
    deadlineLabel,
    destinationUrl,
    destinationLabel: destinations[task.destination],
    delivery,
    deliverDisabledReason,
    shortSha256: formatShortSha256(task.currentPdf?.sha256),
    statusLabel,
    statusTone,
    isConfirmed: task.delivery?.state === 'confirmed',
    canVerify: task.delivery?.state === 'needs_verification',
    canDiscardDelivery: task.delivery?.state === 'failed' || task.delivery?.state === 'needs_verification',
    proofUrl: delivery?.proofUrl ?? null,
    proofDownloadUrl: delivery?.proofDownloadUrl ?? null,
    capturedAtLabel: delivery?.capturedAtLabel ?? null,
    stepper: buildDeliveryStepper(task.delivery),
  };
}
