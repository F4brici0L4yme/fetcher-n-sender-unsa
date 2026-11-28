import { AgentDeliveryPolicy, AgentDeliveryProposal, AutoSyncStatus } from '../../domain/agent-automation';

export const AUTO_SYNC_MONITOR = Symbol('AutoSyncMonitor');

export interface AutoSyncMonitor {
  status(): AutoSyncStatus;
}

export interface CreateAgentProposalInput {
  accountId: string;
  source: string;
  instruction: string;
  taskId: string;
  pdfId: string;
}

export interface AgentAutomationRepository {
  getPolicy(accountId: string): Promise<AgentDeliveryPolicy>;
  setPolicy(accountId: string, policy: AgentDeliveryPolicy): Promise<AgentDeliveryPolicy>;
  listProposals(accountId: string, limit?: number): Promise<AgentDeliveryProposal[]>;
  findProposal(accountId: string, proposalId: string): Promise<AgentDeliveryProposal | null>;
  createProposal(input: CreateAgentProposalInput): Promise<AgentDeliveryProposal>;
  markAuthorized(accountId: string, proposalId: string, deliveryJobId: string): Promise<AgentDeliveryProposal>;
  markRejected(accountId: string, proposalId: string): Promise<AgentDeliveryProposal>;
}
