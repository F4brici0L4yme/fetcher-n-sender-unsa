import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const browserSessions = pgTable('browser_sessions', {
  accountId: text('account_id').primaryKey(),
  expectedIdentity: text('expected_identity').notNull(),
  state: text('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [check('browser_session_valid_state', sql`${table.state} IN ('disconnected','connecting','connected','expired','error')`)]);

export const personalBrowserState = pgTable('personal_browser_state', {
  id: text('id').primaryKey().default('active'),
  accountId: text('account_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [check('personal_browser_singleton', sql`${table.id} = 'active'`)]);
