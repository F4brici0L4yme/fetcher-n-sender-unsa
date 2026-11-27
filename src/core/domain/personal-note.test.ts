import assert from 'node:assert/strict';
import test from 'node:test';
import { NoteValidationError, validateNote } from './personal-note';

const valid = { title: '  Repasar matrices  ', description: 'Leer el capítulo 3.', priority: 'alta', deadline: null, status: 'pendiente' };

test('notes normalize text and optional deadlines while preserving all allowed priorities and statuses', () => {
  for (const priority of ['alta', 'media', 'baja']) {
    for (const status of ['pendiente', 'completado']) {
      assert.deepEqual(validateNote({ ...valid, priority, status, deadline: '' }), {
        ...valid, title: 'Repasar matrices', priority, status,
      });
    }
  }
  assert.equal(validateNote({ ...valid, deadline: '2028-02-29' }).deadline, '2028-02-29');
  assert.equal(validateNote({ ...valid, deadline: '2026-12-05T23:59:00-05:00' }).deadline, '2026-12-06T04:59:00.000Z');
  assert.equal(validateNote({ title: 'Nota', priority: 'media' }).status, 'pendiente');
  assert.equal(validateNote({ title: 'Nota', priority: 'media' }).description, '');
  assert.equal(validateNote({ title: 'Nota', priority: 'media' }).deadline, null);
});

test('notes reject malformed input, enums, field types and text outside the allowed bounds', () => {
  for (const input of [null, [], 'nota', 1, true,
    { ...valid, title: '' }, { ...valid, title: '  ' }, { ...valid, title: 'x'.repeat(201) },
    { ...valid, title: ['Nota'] }, { ...valid, description: [] }, { ...valid, description: 'x'.repeat(10001) },
    { ...valid, priority: ['alta'] }, { ...valid, priority: 'urgente' }, { ...valid, priority: null },
    { ...valid, status: ['pendiente'] }, { ...valid, status: 'confirmed' }, { ...valid, status: null },
    { ...valid, deadline: [] }, { ...valid, deadline: false }, { ...valid, deadline: '2026-02-29' },
    { ...valid, deadline: '2026-12-05T23:59' },
  ]) assert.throws(() => validateNote(input), NoteValidationError);
  assert.equal(validateNote({ ...valid, title: 'x'.repeat(200), description: 'x'.repeat(10000) }).title.length, 200);
});
