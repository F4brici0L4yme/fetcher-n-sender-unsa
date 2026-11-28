import { ApplicationError } from './model';

export type AgentDeliveryPolicy = 'confirm_in_panel' | 'direct_on_exact_match';
export type AgentProposalState = 'pending' | 'authorized' | 'rejected';

export interface AgentDeliveryProposal {
  proposalId: string;
  accountId: string;
  source: string;
  instruction: string;
  taskId: string;
  taskTitle: string;
  taskCourse: string;
  pdfId: string;
  pdfOriginalName: string;
  pdfSha256: string;
  state: AgentProposalState;
  deliveryJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutoSyncStatus {
  enabled: boolean;
  intervalSeconds: number;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  running: boolean;
}

export function normalizeDeliveryPolicy(value: unknown): AgentDeliveryPolicy {
  if (value === 'confirm_in_panel' || value === 'direct_on_exact_match') {
    return value;
  }
  throw new ApplicationError('invalid_policy', 'Selecciona una política de entrega válida.');
}

export function normalizeInstruction(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function normalizeSource(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'panel';
  return value.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 40) || 'panel';
}
