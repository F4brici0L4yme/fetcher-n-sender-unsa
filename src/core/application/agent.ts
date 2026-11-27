import {
  AgentDeliveryPolicy, AgentDeliveryProposal, normalizeDeliveryPolicy, normalizeInstruction, normalizeSource,
} from '../domain/agent-automation';
import { matchTasksForCommand, TaskMatchCandidate, TaskMatchResult } from '../domain/command-matcher';
import { ApplicationError, PdfSummary, TaskView } from '../domain/model';
import { AgentAutomationRepository } from './ports/agent';
import { ProofStore } from './ports/persistence';
import { CargarPdf, ConsultarTrabajo, ListarTareas, SolicitarEntrega } from './tasks';

export class PoliticaAutomatizacion {
  constructor(private readonly repository: AgentAutomationRepository) {}

  get(accountId: string): Promise<AgentDeliveryPolicy> {
    return this.repository.getPolicy(accountId);
  }

  set(accountId: string, policy: unknown): Promise<AgentDeliveryPolicy> {
    return this.repository.setPolicy(accountId, normalizeDeliveryPolicy(policy));
  }
}

export class ListarPropuestasAgente {
  constructor(private readonly repository: AgentAutomationRepository) {}

  execute(accountId: string, limit = 20): Promise<AgentDeliveryProposal[]> {
    return this.repository.listProposals(accountId, limit);
  }
}

export class AnalizarComandoEntrega {
  constructor(private readonly listTasks: ListarTareas) {}

  async execute(accountId: string, instruction: string): Promise<TaskMatchResult> {
    const tasks = await this.listTasks.execute(accountId);
    return matchTasksForCommand(tasks, normalizeInstruction(instruction));
  }
}

export type PrepareAgentDeliveryResult =
  | {
    outcome: 'no_match';
    pdfHint: string | null;
    candidates: TaskMatchCandidate[];
    policy: AgentDeliveryPolicy;
  }
  | {
    outcome: 'ambiguous';
    pdfHint: string | null;
    candidates: TaskMatchCandidate[];
    policy: AgentDeliveryPolicy;
  }
  | {
    outcome: 'pending_confirmation';
    proposal: AgentDeliveryProposal;
    task: TaskView;
    pdf: PdfSummary;
    policy: AgentDeliveryPolicy;
  }
  | {
    outcome: 'authorized';
    proposal: AgentDeliveryProposal;
    jobId: string;
    task: TaskView;
    pdf: PdfSummary;
    policy: AgentDeliveryPolicy;
  };

export class PrepararEntregaAgente {
  constructor(
    private readonly listTasks: ListarTareas,
    private readonly loadPdf: CargarPdf,
    private readonly deliver: SolicitarEntrega,
    private readonly repository: AgentAutomationRepository,
  ) {}

  async execute(input: {
    accountId: string;
    instruction: string;
    taskId?: string;
    originalName: string;
    content: Uint8Array;
    source?: string;
    allowDirectExecution?: boolean;
  }): Promise<PrepareAgentDeliveryResult> {
    const instruction = normalizeInstruction(input.instruction);
    const source = normalizeSource(input.source);
    const [tasks, policy] = await Promise.all([
      this.listTasks.execute(input.accountId),
      this.repository.getPolicy(input.accountId),
    ]);

    let targetTask: TaskView | null = null;
    let unambiguous = false;

    if (input.taskId) {
      targetTask = tasks.find((t) => t.taskId === input.taskId) ?? null;
      if (!targetTask) {
        throw new ApplicationError('not_found', 'La tarea seleccionada no existe.');
      }
      unambiguous = true;
    } else {
      const matched = matchTasksForCommand(tasks, instruction);
      if (matched.kind === 'none') {
        return { outcome: 'no_match', pdfHint: matched.pdfHint, candidates: [], policy };
      }
      if (matched.kind === 'ambiguous' || !matched.match) {
        return { outcome: 'ambiguous', pdfHint: matched.pdfHint, candidates: matched.candidates, policy };
      }
      targetTask = matched.match.task;
      unambiguous = true;
    }

    if (targetTask.destination !== 'aula_virtual') {
      throw new ApplicationError('unsupported_destination', 'Esta tarea no admite entrega directa en Aula Virtual.');
    }
    if (targetTask.delivery && ['authorized', 'running', 'needs_verification'].includes(targetTask.delivery.state)) {
      throw new ApplicationError('delivery_pending', 'Esta tarea ya tiene un intento de entrega en curso o por verificar.');
    }

    const pdf = await this.loadPdf.execute({
      accountId: input.accountId,
      taskId: targetTask.taskId,
      originalName: input.originalName,
      content: input.content,
    });

    const effectiveInstruction = instruction || `Subir ${pdf.originalName} a ${targetTask.title}`;
    const proposal = await this.repository.createProposal({
      accountId: input.accountId,
      source,
      instruction: effectiveInstruction,
      taskId: targetTask.taskId,
      pdfId: pdf.pdfId,
    });

    const canExecuteDirectly = policy === 'direct_on_exact_match'
      && Boolean(input.allowDirectExecution)
      && unambiguous;

    if (canExecuteDirectly) {
      const { jobId } = await this.deliver.execute({
        accountId: input.accountId,
        taskId: targetTask.taskId,
        pdfId: pdf.pdfId,
      });
      const authorizedProposal = await this.repository.markAuthorized(input.accountId, proposal.proposalId, jobId);
      return { outcome: 'authorized', proposal: authorizedProposal, jobId, task: targetTask, pdf, policy };
    }

    return { outcome: 'pending_confirmation', proposal, task: targetTask, pdf, policy };
  }
}

export class AutorizarPropuestaAgente {
  constructor(
    private readonly repository: AgentAutomationRepository,
    private readonly deliver: SolicitarEntrega,
  ) {}

  async execute(accountId: string, proposalId: string): Promise<{ jobId: string; proposal: AgentDeliveryProposal }> {
    const proposal = await this.repository.findProposal(accountId, proposalId);
    if (!proposal) throw new ApplicationError('not_found', 'La propuesta no existe.');
    if (proposal.state !== 'pending') {
      throw new ApplicationError('proposal_not_pending', 'La propuesta ya fue procesada.');
    }
    const { jobId } = await this.deliver.execute({
      accountId,
      taskId: proposal.taskId,
      pdfId: proposal.pdfId,
    });
    const updated = await this.repository.markAuthorized(accountId, proposalId, jobId);
    return { jobId, proposal: updated };
  }
}

export class RechazarPropuestaAgente {
  constructor(private readonly repository: AgentAutomationRepository) {}

  async execute(accountId: string, proposalId: string): Promise<AgentDeliveryProposal> {
    const proposal = await this.repository.findProposal(accountId, proposalId);
    if (!proposal) throw new ApplicationError('not_found', 'La propuesta no existe.');
    if (proposal.state !== 'pending') {
      throw new ApplicationError('proposal_not_pending', 'La propuesta ya fue procesada.');
    }
    return this.repository.markRejected(accountId, proposalId);
  }
}

export class ConsultarCapturaEntrega {
  constructor(
    private readonly jobs: ConsultarTrabajo,
    private readonly proofs: ProofStore,
  ) {}

  async execute(accountId: string, jobId: string): Promise<{
    content: Uint8Array;
    fileName?: string;
    capturedAt?: string;
  }> {
    const job = await this.jobs.execute(accountId, jobId);
    if (job.kind !== 'delivery' || !job.evidence?.proofKey) {
      throw new ApplicationError('not_found', 'No existe captura de comprobante para esta entrega.');
    }
    const content = await this.proofs.readPng(job.evidence.proofKey);
    if (!content) {
      throw new ApplicationError('not_found', 'La captura del comprobante ya no está disponible.');
    }
    return {
      content,
      fileName: job.evidence.fileName,
      capturedAt: job.evidence.capturedAt,
    };
  }
}
