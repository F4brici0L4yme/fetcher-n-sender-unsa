import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { BrowserSessionState } from '../../core/domain/browser-session';
import { browserSessions, personalBrowserState } from './schema-sessions';

export class PostgresBrowserSessionRepository {
  private readonly db;
  constructor(private readonly pool: Pool) { this.db = drizzle(pool); }

  async active() {
    const [row] = await this.db.select().from(personalBrowserState).where(eq(personalBrowserState.id, 'active'));
    if (!row) return null;
    const [session] = await this.db.select().from(browserSessions).where(eq(browserSessions.accountId, row.accountId));
    return session ?? null;
  }

  async select(accountId: string, expectedIdentity: string, state: BrowserSessionState) {
    await this.db.transaction(async (tx) => {
      await tx.insert(browserSessions).values({ accountId, expectedIdentity, state }).onConflictDoUpdate({
        target: browserSessions.accountId, set: { state, updatedAt: sql`now()` },
      });
      await tx.insert(personalBrowserState).values({ id: 'active', accountId }).onConflictDoUpdate({
        target: personalBrowserState.id, set: { accountId, updatedAt: sql`now()` },
      });
    });
  }

  async setState(accountId: string, state: BrowserSessionState) {
    await this.db.update(browserSessions).set({ state, updatedAt: sql`now()` }).where(eq(browserSessions.accountId, accountId));
  }

  async disconnect(accountId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("update jobs set state='failed', summary='Sesión desconectada: autorización cancelada.', updated_at=now() where account_id=$1 and state in ('queued','authorized')", [accountId]);
      await client.query("update browser_sessions set state='disconnected', updated_at=now() where account_id=$1", [accountId]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
}
