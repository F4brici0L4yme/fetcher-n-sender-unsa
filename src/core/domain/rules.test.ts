import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDeadline, visibleDeadline } from './deadline';
import { requireCurrentPdfAndAvailableDelivery, requireDeliveryDestination } from './delivery';

test('un plazo sin hora se mantiene hasta terminar el día en Lima', () => {
  assert.equal(normalizeDeadline('2026-11-24'), '2026-11-24');
  assert.equal(visibleDeadline('2026-11-24', new Date('2026-11-25T04:59:00Z')), true);
  assert.equal(visibleDeadline('2026-11-24', new Date('2026-11-25T05:00:00Z')), false);
  assert.equal(visibleDeadline(null, new Date()), true);
});

test('un plazo con hora conserva su instante y requiere una zona válida', () => {
  const deadline = normalizeDeadline('2026-11-24T10:00:00-05:00');
  assert.equal(deadline, '2026-11-24T15:00:00.000Z');
  assert.equal(visibleDeadline(deadline, new Date('2026-11-24T15:00:00Z')), false);
  assert.throws(() => normalizeDeadline('2026-11-24T10:00:00'), { code: 'invalid_capture' });
  assert.throws(() => normalizeDeadline('2026-02-31'), { code: 'invalid_capture' });
});

test('la entrega exige Aula Virtual, el archivo vigente y una actividad sin intentos pendientes', () => {
  assert.doesNotThrow(() => requireDeliveryDestination('aula_virtual'));
  assert.throws(() => requireDeliveryDestination('other'), { code: 'unsupported_destination' });
  assert.throws(() => requireDeliveryDestination('unknown'), { code: 'unsupported_destination' });
  assert.throws(() => requireCurrentPdfAndAvailableDelivery(false, false), { code: 'stale_pdf' });
  assert.throws(() => requireCurrentPdfAndAvailableDelivery(true, true), { code: 'delivery_pending' });
});
