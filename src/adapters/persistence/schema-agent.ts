import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jobs, pdfs, tasks } from './schema';

const zoned = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const agentDeliveryPolicy = pgEnum('agent_delivery_policy', ['confirm_in_panel', 'direct_on_exact_match']);
export const agentProposalState = pgEnum('agent_proposal_state', ['pending', 'authorized', 'rejected']);

export const accountAutomationSettings = pgTable('account_automation_settings', {
  accountId: text('account_id').primaryKey(),
  deliveryPolicy: agentDeliveryPolicy('delivery_policy').notNull().default('confirm_in_panel'),
  updatedAt: zoned('updated_at').notNull().defaultNow(),
});

export const agentDeliveryProposals = pgTable('agent_delivery_proposals', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull(),
  source: text('source').notNull(),
  instruction: text('instruction').notNull(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  pdfId: uuid('pdf_id').notNull(),
  state: agentProposalState('state').notNull().default('pending'),
  deliveryJobId: uuid('delivery_job_id').references(() => jobs.id),
  createdAt: zoned('created_at').notNull().defaultNow(),
  updatedAt: zoned('updated_at').notNull().defaultNow(),
}, (table) => [
  index('agent_proposals_account_created').on(table.accountId, table.createdAt),
  index('agent_proposals_task_pdf').on(table.taskId, table.pdfId),
  foreignKey({ columns: [table.taskId, table.pdfId], foreignColumns: [pdfs.taskId, pdfs.id] }),
  check('agent_proposal_source_length', sql`char_length(btrim(${table.source})) BETWEEN 1 AND 40`),
  check('agent_proposal_instruction_length', sql`char_length(${table.instruction}) <= 500`),
]);
