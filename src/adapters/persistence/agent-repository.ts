import { and, desc, eq, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AgentAutomationRepository, CreateAgentProposalInput } from '../../core/application/ports/agent';
import { AgentDeliveryPolicy, AgentDeliveryProposal } from '../../core/domain/agent-automation';
import { ApplicationError } from '../../core/domain/model';
import * as schema from './schema';

const { accountAutomationSettings, agentDeliveryProposals, jobs, pdfs, tasks } = schema;
type Database = NodePgDatabase<typeof schema>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface JoinedProposalRow {
  proposal: typeof agentDeliveryProposals.$inferSelect;
  taskTitle: string;
  taskCourse: string;
  pdfOriginalName: string;
  pdfSha256: string;
}

function presentProposal({
  proposal,
  taskTitle,
  taskCourse,
  pdfOriginalName,
  pdfSha256,
}: JoinedProposalRow): AgentDeliveryProposal {
  return {
    proposalId: proposal.id,
    accountId: proposal.accountId,
    source: proposal.source,
    instruction: proposal.instruction,
    taskId: proposal.taskId,
    taskTitle,
    taskCourse,
    pdfId: proposal.pdfId,
    pdfOriginalName,
    pdfSha256,
    state: proposal.state,
    deliveryJobId: proposal.deliveryJobId,
    createdAt: new Date(proposal.createdAt).toISOString(),
    updatedAt: new Date(proposal.updatedAt).toISOString(),
  };
}

export class PostgresAgentAutomationRepository implements AgentAutomationRepository {
  constructor(private readonly db: Database) {}

  async getPolicy(accountId: string): Promise<AgentDeliveryPolicy> {
    const [row] = await this.db
      .select({ deliveryPolicy: accountAutomationSettings.deliveryPolicy })
      .from(accountAutomationSettings)
      .where(eq(accountAutomationSettings.accountId, accountId));
    return row?.deliveryPolicy ?? 'confirm_in_panel';
  }

  async setPolicy(accountId: string, policy: AgentDeliveryPolicy): Promise<AgentDeliveryPolicy> {
    const [row] = await this.db
      .insert(accountAutomationSettings)
      .values({ accountId, deliveryPolicy: policy, updatedAt: sql`now()` })
      .onConflictDoUpdate({
        target: accountAutomationSettings.accountId,
        set: { deliveryPolicy: policy, updatedAt: sql`now()` },
      })
      .returning({ deliveryPolicy: accountAutomationSettings.deliveryPolicy });
    if (!row) throw new Error('No se pudo guardar la política de automatización.');
    return row.deliveryPolicy;
  }

  async listProposals(accountId: string, limit = 20): Promise<AgentDeliveryProposal[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    const rows = await this.selectJoined(this.db)
      .where(eq(agentDeliveryProposals.accountId, accountId))
      .orderBy(desc(agentDeliveryProposals.createdAt), desc(agentDeliveryProposals.id))
      .limit(safeLimit);
    return rows.map(presentProposal);
  }

  async findProposal(accountId: string, proposalId: string): Promise<AgentDeliveryProposal | null> {
    if (!UUID_PATTERN.test(proposalId)) return null;
    const [row] = await this.selectJoined(this.db)
      .where(and(eq(agentDeliveryProposals.accountId, accountId), eq(agentDeliveryProposals.id, proposalId)));
    return row ? presentProposal(row) : null;
  }

  async createProposal(input: CreateAgentProposalInput): Promise<AgentDeliveryProposal> {
    if (!UUID_PATTERN.test(input.taskId) || !UUID_PATTERN.test(input.pdfId)) {
      throw new ApplicationError('not_found', 'La tarea o el PDF indicado no existen para esta cuenta.');
    }
    return this.db.transaction(async (tx) => {
      const [binding] = await tx
        .select({
          taskTitle: tasks.title,
          taskCourse: tasks.course,
          pdfOriginalName: pdfs.originalName,
          pdfSha256: pdfs.sha256,
        })
        .from(tasks)
        .innerJoin(pdfs, and(eq(pdfs.taskId, tasks.id), eq(pdfs.id, input.pdfId)))
        .where(and(eq(tasks.id, input.taskId), eq(tasks.accountId, input.accountId)));
      if (!binding) {
        throw new ApplicationError('not_found', 'La tarea o el PDF indicado no existen para esta cuenta.');
      }

      const [inserted] = await tx
        .insert(agentDeliveryProposals)
        .values({
          accountId: input.accountId,
          source: input.source,
          instruction: input.instruction,
          taskId: input.taskId,
          pdfId: input.pdfId,
          state: 'pending',
          createdAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .returning();
      if (!inserted) throw new Error('No se pudo crear la propuesta de entrega.');

      return presentProposal({
        proposal: inserted,
        taskTitle: binding.taskTitle,
        taskCourse: binding.taskCourse,
        pdfOriginalName: binding.pdfOriginalName,
        pdfSha256: binding.pdfSha256,
      });
    });
  }

  async markAuthorized(
    accountId: string,
    proposalId: string,
    deliveryJobId: string,
  ): Promise<AgentDeliveryProposal> {
    if (!UUID_PATTERN.test(proposalId) || !UUID_PATTERN.test(deliveryJobId)) {
      throw new ApplicationError('not_found', 'La propuesta no existe.');
    }
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.id, deliveryJobId), eq(jobs.accountId, accountId)));
      if (!job) {
        const [existing] = await tx
          .select({ state: agentDeliveryProposals.state })
          .from(agentDeliveryProposals)
          .where(and(eq(agentDeliveryProposals.id, proposalId), eq(agentDeliveryProposals.accountId, accountId)));
        if (existing && existing.state !== 'pending') {
          throw new ApplicationError('proposal_not_pending', 'La propuesta ya fue procesada.');
        }
        throw new ApplicationError('not_found', 'El trabajo de entrega no existe para esta cuenta.');
      }

      const [updated] = await tx
        .update(agentDeliveryProposals)
        .set({
          state: 'authorized',
          deliveryJobId,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(
          eq(agentDeliveryProposals.id, proposalId),
          eq(agentDeliveryProposals.accountId, accountId),
          eq(agentDeliveryProposals.state, 'pending'),
        ))
        .returning();

      if (!updated) {
        const [existing] = await tx
          .select({ id: agentDeliveryProposals.id })
          .from(agentDeliveryProposals)
          .where(and(eq(agentDeliveryProposals.id, proposalId), eq(agentDeliveryProposals.accountId, accountId)));
        if (!existing) {
          throw new ApplicationError('not_found', 'La propuesta no existe.');
        }
        throw new ApplicationError('proposal_not_pending', 'La propuesta ya fue procesada.');
      }

      return this.hydrateProposal(tx, updated);
    });
  }

  async markRejected(accountId: string, proposalId: string): Promise<AgentDeliveryProposal> {
    if (!UUID_PATTERN.test(proposalId)) {
      throw new ApplicationError('not_found', 'La propuesta no existe.');
    }
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(agentDeliveryProposals)
        .set({
          state: 'rejected',
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(
          eq(agentDeliveryProposals.id, proposalId),
          eq(agentDeliveryProposals.accountId, accountId),
          eq(agentDeliveryProposals.state, 'pending'),
        ))
        .returning();

      if (!updated) {
        const [existing] = await tx
          .select({ id: agentDeliveryProposals.id })
          .from(agentDeliveryProposals)
          .where(and(eq(agentDeliveryProposals.id, proposalId), eq(agentDeliveryProposals.accountId, accountId)));
        if (!existing) {
          throw new ApplicationError('not_found', 'La propuesta no existe.');
        }
        throw new ApplicationError('proposal_not_pending', 'La propuesta ya fue procesada.');
      }

      return this.hydrateProposal(tx, updated);
    });
  }

  private selectJoined(executor: Pick<Database, 'select'>) {
    return executor
      .select({
        proposal: agentDeliveryProposals,
        taskTitle: tasks.title,
        taskCourse: tasks.course,
        pdfOriginalName: pdfs.originalName,
        pdfSha256: pdfs.sha256,
      })
      .from(agentDeliveryProposals)
      .innerJoin(
        tasks,
        and(eq(tasks.id, agentDeliveryProposals.taskId), eq(tasks.accountId, agentDeliveryProposals.accountId)),
      )
      .innerJoin(
        pdfs,
        and(eq(pdfs.taskId, agentDeliveryProposals.taskId), eq(pdfs.id, agentDeliveryProposals.pdfId)),
      );
  }

  private async hydrateProposal(
    executor: Pick<Database, 'select'>,
    proposal: typeof agentDeliveryProposals.$inferSelect,
  ): Promise<AgentDeliveryProposal> {
    const [binding] = await executor
      .select({
        taskTitle: tasks.title,
        taskCourse: tasks.course,
        pdfOriginalName: pdfs.originalName,
        pdfSha256: pdfs.sha256,
      })
      .from(tasks)
      .innerJoin(pdfs, and(eq(pdfs.taskId, tasks.id), eq(pdfs.id, proposal.pdfId)))
      .where(and(eq(tasks.id, proposal.taskId), eq(tasks.accountId, proposal.accountId)));
    if (!binding) {
      throw new ApplicationError('not_found', 'La tarea o el PDF asociado ya no existen.');
    }
    return presentProposal({
      proposal,
      taskTitle: binding.taskTitle,
      taskCourse: binding.taskCourse,
      pdfOriginalName: binding.pdfOriginalName,
      pdfSha256: binding.pdfSha256,
    });
  }
}
