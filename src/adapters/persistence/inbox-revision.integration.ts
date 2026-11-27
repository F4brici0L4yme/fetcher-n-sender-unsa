import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { postgresDatabase } from './repositories';

test('committed mutations advance durable account revisions, including deletion and rollback', async (t) => {
  assert.ok(process.env.DATABASE_URL);
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const name = 'revision_test_' + randomUUID().replaceAll('-', '');
  await admin.query('create database ' + name);
  const url = new URL(process.env.DATABASE_URL); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: url.toString() });
  t.after(async () => { await pool.end(); await admin.query('drop database ' + name); await admin.end(); });
  await migrate(postgresDatabase(pool), { migrationsFolder: 'src/adapters/persistence/migrations' });
  const table = await pool.query("select to_regclass('account_revisions') as relation");
  assert.ok(table.rows[0].relation, 'migration must create durable account revisions');
  const revision = async (id: string) => (await pool.query('select revision from account_revisions where account_id=$1', [id])).rows[0]?.revision ?? '0';
  const initial = await revision('a');
  const created = await pool.query("insert into tasks(account_id,external_id,course,title,activity_url,destination) values('a','1','Course','Title','https://example.invalid/2026B/mod/assign/view.php?id=1','aula_virtual') returning id");
  const afterCreate = await revision('a'); assert.notEqual(afterCreate, initial);
  assert.equal(await revision('b'), '0');
  await pool.query('delete from tasks where id=$1', [created.rows[0].id]);
  const afterDelete = await revision('a'); assert.notEqual(afterDelete, afterCreate);
  const listener = await pool.connect();
  await listener.query('LISTEN fetcher_tasks_changed');
  const mutations = [
    ["insert into jobs(account_id,kind,state) values('a','search','queued')", "update jobs set summary='changed' where account_id='a'", "delete from jobs where account_id='a'"],
    ["insert into personal_notes(account_id,title,priority) values('a','Note','alta')", "update personal_notes set title='Changed' where account_id='a'", "delete from personal_notes where account_id='a'"],
    ["insert into browser_sessions(account_id,expected_identity,state) values('a','student@example.invalid','connected')", "update browser_sessions set state='expired' where account_id='a'", "delete from browser_sessions where account_id='a'"],
    ["insert into personal_browser_state(account_id) values('a')", "update personal_browser_state set account_id='b'", "delete from personal_browser_state"],
  ];
  try {
    for (const statements of mutations) {
      for (const statement of statements) {
        const account = statement.startsWith('delete from personal_browser_state') ? 'b' : 'a';
        const before = await revision(account);
        const notice = once(listener, 'notification', { signal: AbortSignal.timeout(5000) });
        await pool.query(statement);
        const [event] = await notice;
        assert.equal(event.channel, 'fetcher_tasks_changed');
        assert.ok(['a', 'b'].includes(event.payload));
        assert.ok(BigInt(await revision(account)) > BigInt(before), statement);
      }
    }
  } finally { await listener.query('UNLISTEN fetcher_tasks_changed'); listener.release(); }
  const beforeRollback = await revision('a');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("insert into jobs(account_id,kind,state) values('a','search','queued')");
    await client.query('rollback');
  } finally { client.release(); }
  assert.equal(await revision('a'), beforeRollback);
});
