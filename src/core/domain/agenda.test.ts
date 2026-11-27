import assert from 'node:assert/strict';
import test from 'node:test';
import { compareAgendaItems } from './agenda';

test('agenda interleaves academic tasks and personal notes ordered by deadline, pending before completed, and title', () => {
  const items = [
    { kind: 'note' as const, id: 'n3', title: 'Sin fecha', deadline: null, completed: false },
    { kind: 'task' as const, id: 't2', title: 'Informe tardío', deadline: '2026-12-10', completed: false },
    { kind: 'note' as const, id: 'n1', title: 'Repasar examen', deadline: '2026-12-01', completed: false },
    { kind: 'note' as const, id: 'n2', title: 'Nota completada', deadline: '2026-11-01', completed: true },
    { kind: 'task' as const, id: 't1', title: 'Práctica 1', deadline: '2026-12-05T23:59:00.000Z', completed: false },
  ];
  items.sort(compareAgendaItems);
  assert.deepEqual(items.map((item) => item.id), ['n1', 't1', 't2', 'n3', 'n2']);
});
