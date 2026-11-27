import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { PersonalNotes } from '../../core/application/notes';
import { ApplicationError } from '../../core/domain/model';
import { PostgresNoteRepository } from './note-repository';
import { postgresDatabase } from './repositories';
import { TASK_CHANGES_CHANNEL } from './task-changes';

test('personal notes persist isolated CRUD and notify the account after every mutation', async (suite) => {
  assert.ok(process.env.DATABASE_URL, 'Ejecuta test:integration dentro de Docker Compose.');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const database = 'notes_test_' + randomUUID().replaceAll('-', '');
  await admin.query('create database ' + database);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + database;
  const pool = new Pool({ connectionString: url.toString() });
  suite.after(async () => {
    await pool.end();
    await admin.query('drop database ' + database);
    await admin.end();
  });
  const db = postgresDatabase(pool);
  await migrate(db, { migrationsFolder: 'src/adapters/persistence/migrations' });
  const listener = await pool.connect();
  await listener.query('LISTEN ' + TASK_CHANGES_CHANNEL);
  const notes = new PersonalNotes(new PostgresNoteRepository(db));
  const fields = { title: 'Repasar', description: 'Métodos numéricos', priority: 'alta', deadline: '2020-01-01', status: 'pendiente' };
  async function mutation<T>(run: () => Promise<T>): Promise<T> {
    const notice = once(listener, 'notification', { signal: AbortSignal.timeout(5000) });
    const result = await run();
    const [event] = await notice as [{ channel: string; payload: string }];
    assert.equal(event.channel, TASK_CHANGES_CHANNEL);
    assert.equal(event.payload, 'notes-owner');
    return result;
  }
  try {
    const note = await mutation(() => notes.create('notes-owner', fields));
    assert.equal((await notes.list('notes-owner'))[0]?.deadline, '2020-01-01');
    assert.deepEqual(await notes.list('another-account'), []);
    const missing = (error: unknown) => error instanceof ApplicationError && error.code === 'not_found';
    await assert.rejects(() => notes.find('another-account', note.noteId), missing);
    await assert.rejects(() => notes.update('another-account', note.noteId, fields), missing);
    await assert.rejects(() => notes.complete('another-account', note.noteId), missing);
    await assert.rejects(() => notes.remove('another-account', note.noteId), missing);
    const updated = await mutation(() => notes.update('notes-owner', note.noteId, {
      ...fields, title: 'Actualizada', priority: 'baja', deadline: '2026-12-05T23:59:00-05:00',
    }));
    assert.equal(updated.title, 'Actualizada');
    assert.equal(updated.deadline, '2026-12-06T04:59:00.000Z');
    assert.equal((await mutation(() => notes.complete('notes-owner', note.noteId))).status, 'completado');
    assert.equal((await notes.list('notes-owner')).length, 1);
    await mutation(() => notes.remove('notes-owner', note.noteId));
    assert.deepEqual(await notes.list('notes-owner'), []);
  } finally {
    await listener.query('UNLISTEN ' + TASK_CHANGES_CHANNEL);
    listener.release();
  }
});
