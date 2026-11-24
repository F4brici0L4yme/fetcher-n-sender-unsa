import assert from 'node:assert/strict';
import test from 'node:test';
import { CargarPdf, MAX_PDF_BYTES } from './tasks';
import { PdfStore, TaskRepository } from './ports/persistence';
import { ApplicationError } from '../domain/model';

test('rechaza archivos inválidos y nombres con rutas antes de tocar el almacén', async () => {
  const files: PdfStore = {
    write: async () => assert.fail('No debe guardar un archivo inválido'),
    discard: async () => assert.fail(), path: () => assert.fail(), verifiedPath: async () => assert.fail(),
  };
  const tasks: TaskRepository = {
    attachPdf: async () => assert.fail(), find: async () => null, list: async () => [],
  };
  const useCase = new CargarPdf(tasks, files);
  const base = { accountId: 'test', taskId: 'one', originalName: 'informe.pdf' };
  for (const content of [new Uint8Array(), new Uint8Array(MAX_PDF_BYTES + 1), Buffer.from('%PDF-1.4\ncorrupto')]) {
    await assert.rejects(useCase.execute({ ...base, content }), { code: 'invalid_pdf' });
  }
  await assert.rejects(useCase.execute({
    ...base, originalName: '../informe.pdf', content: Buffer.from('%PDF-1.4\n%%EOF\n'),
  }), { code: 'invalid_pdf' });
});

test('descarta una carga rechazada sin eliminar archivos de otras cargas', async () => {
  const discarded: string[] = [];
  const files: PdfStore = {
    write: async () => ({ pdfId: 'new', storageKey: 'new.pdf', sizeBytes: 15, sha256: 'hash' }),
    discard: async (key) => { discarded.push(key); },
    path: () => assert.fail(), verifiedPath: async () => assert.fail(),
  };
  const tasks: TaskRepository = {
    attachPdf: async () => { throw new ApplicationError('not_found', 'No existe.'); },
    find: async () => null, list: async () => [],
  };
  await assert.rejects(new CargarPdf(tasks, files).execute({
    accountId: 'test', taskId: 'one', originalName: 'informe.pdf', content: Buffer.from('%PDF-1.4\n%%EOF\n'),
  }), { code: 'not_found' });
  assert.deepEqual(discarded, ['new.pdf']);
});
