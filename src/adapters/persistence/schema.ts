import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, date, foreignKey, index, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

export const destination = pgEnum('destination', ['aula_virtual', 'other', 'unknown']);
export const jobKind = pgEnum('job_kind', ['search', 'delivery']);
export const jobState = pgEnum('job_state', [
  'queued', 'authorized', 'running', 'completed', 'confirmed', 'failed', 'needs_verification',
]);
const zoned = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const tasks = pgTable('tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull(),
  externalId: text('external_id').notNull(),
  course: text('course').notNull(),
  title: text('title').notNull(),
  activityUrl: text('activity_url').notNull(),
  deadlineDate: date('deadline_date'),
  deadlineAt: zoned('deadline_at'),
  destination: destination('destination').notNull(),
}, (table) => [
  unique().on(table.accountId, table.externalId),
  check('task_single_deadline', sql`${table.deadlineDate} IS NULL OR ${table.deadlineAt} IS NULL`),
]);

export const pdfs = pgTable('pdfs', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  originalName: text('original_name').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  current: boolean('current').notNull(),
}, (table) => [
  unique().on(table.taskId, table.id),
  uniqueIndex('pdf_one_current_per_task').on(table.taskId).where(sql`${table.current}`),
  check('pdf_valid_size', sql`${table.byteSize} BETWEEN 1 AND 20971520`),
]);

export const jobs = pgTable('jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull(),
  kind: jobKind('kind').notNull(),
  state: jobState('state').notNull(),
  summary: text('summary'),
  verifyRequested: boolean('verify_requested').notNull().default(false),
  createdAt: zoned('created_at').notNull().defaultNow(),
  updatedAt: zoned('updated_at').notNull().defaultNow(),
}, (table) => [
  index('jobs_queue').on(table.accountId, table.state, table.createdAt),
  check('job_state_matches_kind', sql`
    (${table.kind} = 'search' AND ${table.state} IN ('queued', 'running', 'completed', 'failed'))
    OR (${table.kind} = 'delivery' AND ${table.state} IN ('authorized', 'running', 'confirmed', 'failed', 'needs_verification'))
  `),
  check('job_verification_only_when_uncertain', sql`NOT ${table.verifyRequested} OR ${table.state} = 'needs_verification'`),
]);

export const deliveries = pgTable('deliveries', {
  jobId: uuid('job_id').primaryKey().references(() => jobs.id),
  taskId: uuid('task_id').notNull(),
  pdfId: uuid('pdf_id').notNull(),
  externalId: text('external_id').notNull(),
  activityUrl: text('activity_url').notNull(),
  originalName: text('original_name').notNull(),
  sha256: text('sha256').notNull(),
  storageKey: text('storage_key').notNull(),
  observedActivityUrl: text('observed_activity_url'),
  visibleStatus: text('visible_status'),
  observedFileName: text('observed_file_name'),
  portalReference: text('portal_reference'),
}, (table) => [
  unique().on(table.taskId, table.pdfId),
  foreignKey({ columns: [table.taskId, table.pdfId], foreignColumns: [pdfs.taskId, pdfs.id] }),
]);
