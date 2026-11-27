import assert from 'node:assert/strict';
import test from 'node:test';
import { PersonalNotes } from './notes';
import { NoteRepository } from './ports/notes';
import { NoteFields, NoteValidationError, PersonalNote } from '../domain/personal-note';
import { ApplicationError } from '../domain/model';

function repository(): NoteRepository {
  const rows = new Map<string, PersonalNote>();
  let next = 0;
  const find = (accountId: string, noteId: string) => {
    const row = rows.get(noteId);
    return row?.accountId === accountId ? row : null;
  };
  return {
    async list(accountId) { return [...rows.values()].filter((row) => row.accountId === accountId); },
    async find(accountId, noteId) { return find(accountId, noteId); },
    async create(accountId, fields) {
      const row = { ...fields, accountId, noteId: String(++next) };
      rows.set(row.noteId, row);
      return row;
    },
    async update(accountId, noteId, fields) {
      const row = find(accountId, noteId);
      if (!row) return null;
      const updated = { ...row, ...fields };
      rows.set(noteId, updated);
      return updated;
    },
    async complete(accountId, noteId) {
      const row = find(accountId, noteId);
      if (!row) return null;
      const updated: PersonalNote = { ...row, status: 'completado' };
      rows.set(noteId, updated);
      return updated;
    },
    async remove(accountId, noteId) { return find(accountId, noteId) ? rows.delete(noteId) : false; },
  };
}

const fields: NoteFields = { title: 'Recordatorio', description: '', priority: 'media', deadline: null, status: 'pendiente' };

test('notes support account-scoped CRUD and completion without hiding overdue or completed entries', async () => {
  const notes = new PersonalNotes(repository());
  const created = await notes.create('one', { ...fields, deadline: '2020-01-01' });
  assert.equal((await notes.list('one')).length, 1);
  assert.deepEqual(await notes.list('two'), []);
  assert.equal((await notes.find('one', created.noteId)).deadline, '2020-01-01');
  const updated = await notes.update('one', created.noteId, { ...fields, title: '  Editada  ', priority: 'alta' });
  assert.equal(updated.title, 'Editada');
  assert.equal(updated.priority, 'alta');
  assert.equal((await notes.complete('one', created.noteId)).status, 'completado');
  assert.equal((await notes.list('one')).length, 1);
  assert.equal((await notes.complete('one', created.noteId)).status, 'completado');
  await notes.remove('one', created.noteId);
  assert.deepEqual(await notes.list('one'), []);
});

test('notes reject missing or cross-account mutations and invalid values before persistence', async () => {
  const notes = new PersonalNotes(repository());
  const created = await notes.create('owner', fields);
  const missing = (error: unknown) => error instanceof ApplicationError && error.code === 'not_found';
  await assert.rejects(() => notes.find('other', created.noteId), missing);
  await assert.rejects(() => notes.update('other', created.noteId, fields), missing);
  await assert.rejects(() => notes.complete('other', created.noteId), missing);
  await assert.rejects(() => notes.remove('other', created.noteId), missing);
  await assert.rejects(() => notes.find('owner', 'missing'), missing);
  await assert.rejects(() => notes.create('owner', { ...fields, priority: [] }), NoteValidationError);
  await assert.rejects(() => notes.update('owner', created.noteId, { ...fields, title: '' }), NoteValidationError);
  assert.deepEqual((await notes.list('owner'))[0], created);
});
