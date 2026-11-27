import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { engine } from 'express-handlebars';
import { join } from 'node:path';
import test from 'node:test';
import { PersonalNotes } from '../../core/application/notes';
import { NoteRepository } from '../../core/application/ports/notes';
import { PersonalNote } from '../../core/domain/personal-note';
import { NotesController } from './controllers/notes.controller';
import { PANEL_ACCOUNT } from './panel.tokens';
import { PanelWriteGuard } from './panel-write.guard';

test('notes HTTP endpoints validate values, pin the active account and render escaped accessible forms', async () => {
  const noteId = '0ecd25cb-61f5-49a7-83b9-bdb97e5afdb0';
  let accountId = 'one';
  let note: PersonalNote | null = null;
  const find = (account: string, id: string) => note?.accountId === account && note.noteId === id ? note : null;
  const repository: NoteRepository = {
    async list(account) { return note?.accountId === account ? [note] : []; },
    async find(account, id) { return find(account, id); },
    async create(account, fields) { note = { ...fields, accountId: account, noteId }; return note; },
    async update(account, id, fields) {
      const row = find(account, id);
      if (!row) return null;
      note = { ...row, ...fields }; return note;
    },
    async complete(account, id) {
      const row = find(account, id);
      if (!row) return null;
      note = { ...row, status: 'completado' }; return note;
    },
    async remove(account, id) { if (!find(account, id)) return false; note = null; return true; },
  };
  @Module({
    controllers: [NotesController],
    providers: [PanelWriteGuard,
      { provide: PANEL_ACCOUNT, useValue: { current: () => accountId } },
      { provide: PersonalNotes, useValue: new PersonalNotes(repository) },
    ],
  })
  class TestModule {}
  const app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
  app.engine('hbs', engine({ extname: '.hbs', defaultLayout: false }));
  app.setViewEngine('hbs');
  app.setBaseViewsDir(join(__dirname, 'views'));
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(origin + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body), redirect: 'manual',
  });
  const fields = { accountId: 'one', title: '<script>alert(1)</script>', description: 'Detalles', priority: 'alta', deadline: '2026-12-05', status: 'pendiente' };
  try {
    assert.equal((await post('/notas', fields)).status, 303);
    assert.equal((await post('/notas', { ...fields, priority: ['alta'] })).status, 400);
    const page = await fetch(origin + '/notas/' + noteId);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /<label for="note-title">/);
    assert.match(html, /name="accountId" value="one"/);
    assert.match(html, /value="alta" selected/);
    assert.equal((await post(`/notas/${noteId}/editar`, { ...fields, title: 'Editada', priority: 'baja' })).status, 303);
    assert.equal((await repository.find('one', noteId))?.title, 'Editada');
    assert.equal((await post(`/notas/${noteId}/completar`, { accountId: 'one' })).status, 303);
    assert.equal((await repository.find('one', noteId))?.status, 'completado');
    assert.equal((await post('/notas', fields, { origin: 'https://attacker.invalid' })).status, 403);
    accountId = 'two';
    assert.equal((await post(`/notas/${noteId}/eliminar`, { accountId: 'one' })).status, 409);
    assert.equal((await post(`/notas/${noteId}/eliminar`, { accountId: 'two' })).status, 404);
    assert.equal((await fetch(origin + '/notas/' + noteId)).status, 404);
    accountId = 'one';
    assert.equal((await post(`/notas/${noteId}/eliminar`, { accountId: 'one' })).status, 303);
    assert.equal(await repository.find('one', noteId), null);
  } finally { await app.close(); }
});
