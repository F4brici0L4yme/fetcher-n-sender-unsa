import { sql } from 'drizzle-orm';
import { check, date, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const notePriority = pgEnum('note_priority', ['alta', 'media', 'baja']);
export const noteStatus = pgEnum('note_status', ['pendiente', 'completado']);

export const personalNotes = pgTable('personal_notes', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  priority: notePriority('priority').notNull(),
  status: noteStatus('status').notNull().default('pendiente'),
  deadlineDate: date('deadline_date'),
  deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => [
  index('personal_notes_account_status').on(table.accountId, table.status),
  check('personal_notes_title_length', sql`char_length(btrim(${table.title})) BETWEEN 1 AND 200`),
  check('personal_notes_description_length', sql`char_length(${table.description}) <= 10000`),
  check('personal_notes_single_deadline', sql`${table.deadlineDate} IS NULL OR ${table.deadlineAt} IS NULL`),
]);
