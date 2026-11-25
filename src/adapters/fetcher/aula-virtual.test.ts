import assert from 'node:assert/strict';
import test from 'node:test';
import { AulaVirtualFetcher, VisualCaptureRunner } from './aula-virtual';

const portal = 'https://aula.example.edu';
const accountId = 'student-test';
const now = () => new Date('2026-11-25T12:00:00-05:00');

function assignment(id: string, deadline: string | null, destination = 'aula_virtual') {
  return {
    externalId: id, course: 'Métodos numéricos', title: `Práctica ${id}`,
    activityUrl: `${portal}/mod/assign/view.php?id=${id}`, deadline, destination,
  };
}

test('despacha una lectura y conserva solo tareas futuras o abiertas sin fecha', async () => {
  const calls: unknown[] = [];
  const runner: VisualCaptureRunner = { async capture(request) {
    calls.push(request);
    return { kind: 'success', observedAccountId: accountId, assignments: [
      assignment('1', '2026-11-26'), assignment('2', null),
      assignment('3', '2026-11-24'), assignment('4', '2026-11-26', 'other'),
      assignment('5', '2026-11-26', 'unknown'),
    ] };
  } };
  const fetcher = new AulaVirtualFetcher({ portalUrl: portal, accountId, runner, clock: now });

  assert.deepEqual(await fetcher.fetch({ jobId: 'job-1', accountId }), {
    kind: 'success', assignments: [
      assignment('1', '2026-11-26'), assignment('2', null),
      assignment('4', '2026-11-26', 'other'), assignment('5', '2026-11-26', 'unknown'),
    ],
  });
  assert.deepEqual(calls, [{ jobId: 'job-1', accountId, portalUrl: `${portal}/`, readOnly: true }]);
});

test('distingue búsqueda vacía, sesión vencida e integración no disponible', async () => {
  const empty = new AulaVirtualFetcher({ portalUrl: portal, accountId, runner: {
    async capture() { return { kind: 'success', observedAccountId: accountId, assignments: [] }; },
  } });
  assert.deepEqual(await empty.fetch({ jobId: 'job-2', accountId }), { kind: 'success', assignments: [] });
  const expired = new AulaVirtualFetcher({ portalUrl: portal, accountId, runner: {
    async capture() { return { kind: 'session_expired' }; },
  } });
  assert.deepEqual(await expired.fetch({ jobId: 'job-3', accountId }), { kind: 'session_expired' });
  const unavailable = new AulaVirtualFetcher({ portalUrl: portal, accountId, runner: null });
  assert.deepEqual(await unavailable.fetch({ jobId: 'job-4', accountId }), { kind: 'unavailable' });
});

test('rechaza una cuenta distinta, otro portal y capturas mal formadas', async () => {
  for (const response of [
    { kind: 'success', observedAccountId: 'other-student', assignments: [assignment('1', null)] },
    { kind: 'success', observedAccountId: accountId, assignments: [{ ...assignment('1', null), activityUrl: 'https://other.example/mod/assign/view.php?id=1' }] },
    { kind: 'success', observedAccountId: accountId, assignments: [{ ...assignment('1', null), activityUrl: 'http://aula.example.edu/mod/assign/view.php?id=1' }] },
    { kind: 'success', observedAccountId: accountId, assignments: [{ ...assignment('1', null), activityUrl: 'https://aula.example.edu/admin/' }] },
    { kind: 'success', observedAccountId: accountId, assignments: [{ ...assignment('1', null), deadline: 'not-a-date' }] },
    { kind: 'success', observedAccountId: accountId, assignments: [{ ...assignment('1', null), destination: ['aula_virtual'] }] },
  ] as const) {
    const fetcher = new AulaVirtualFetcher({ portalUrl: portal, accountId, runner: {
      async capture() { return response; },
    } });
    assert.deepEqual(await fetcher.fetch({ jobId: 'job-5', accountId }), { kind: 'failed' });
  }
});

test('no inicia lectura para otra cuenta', async () => {
  let calls = 0;
  const fetcher = new AulaVirtualFetcher({ portalUrl: portal, accountId, runner: {
    async capture() { calls++; return { kind: 'success', observedAccountId: accountId, assignments: [] }; },
  } });
  assert.deepEqual(await fetcher.fetch({ jobId: 'job-7', accountId: 'other-student' }), { kind: 'failed' });
  assert.equal(calls, 0);
});

test('acepta actividades bajo la ruta configurada del periodo académico', async () => {
  const activity = {
    ...assignment('9', null),
    activityUrl: `${portal}/2026B/mod/assign/view.php?id=9`,
  };
  const calls: unknown[] = [];
  const fetcher = new AulaVirtualFetcher({
    portalUrl: `${portal}/2026B/?redirect=0`, accountId, clock: now,
    runner: { async capture(request) {
      calls.push(request);
      return { kind: 'success', observedAccountId: accountId, assignments: [activity] };
    } },
  });
  assert.deepEqual(await fetcher.fetch({ jobId: 'job-8', accountId }), {
    kind: 'success', assignments: [activity],
  });
  assert.deepEqual(calls, [{ jobId: 'job-8', accountId, portalUrl: `${portal}/2026B/`, readOnly: true }]);
});

test('rechaza una ruta de portal que pueda cambiar el origen configurado', () => {
  assert.throws(() => new AulaVirtualFetcher({
    portalUrl: `${portal}//other.example/2026B/`, accountId, runner: null,
  }), /portalUrl/);
});

test('un error del agente no se interpreta como una búsqueda vacía', async () => {
  const fetcher = new AulaVirtualFetcher({ portalUrl: portal, accountId, runner: {
    async capture() { throw new Error('browser disconnected'); },
  } });
  assert.deepEqual(await fetcher.fetch({ jobId: 'job-6', accountId }), { kind: 'failed' });
});
