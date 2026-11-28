import assert from 'node:assert/strict';
import test from 'node:test';
import { DeliveryOrder } from '../../core/domain/model';
import { AulaVirtualDeliveryBrowser, DeliveryPageEditor, DeliveryPageObservation, DeliveryTarget } from './aula-virtual-delivery-browser';
import { AulaVirtualSender } from './aula-virtual-sender';

const activityUrl = 'https://aula.example.edu/2026B/mod/assign/view.php?id=12';
const order: DeliveryOrder = {
  jobId: 'job-1', accountId: 'alumno-local', externalId: '12', activityUrl,
  pdfId: 'pdf-1', localFilePath: '/data/uploads/archivo.pdf', originalName: 'Informe.pdf', sha256: 'a'.repeat(64),
};
const target: DeliveryTarget = { jobId: order.jobId, accountId: order.accountId, externalId: order.externalId, activityUrl };
const initial: DeliveryPageObservation = { ...target, state: 'open', visibleStatus: 'Sin envío', attachments: [] };
const draft: DeliveryPageObservation = {
  ...initial, state: 'draft', visibleStatus: 'Borrador', attachments: [{ name: order.originalName }],
};
const submitted: DeliveryPageObservation = {
  ...draft, state: 'submitted', visibleStatus: 'Enviado para calificar', portalReference: 'recibo-1',
};

function simulate(observations: DeliveryPageObservation[], interruption?: 'attach' | 'submit') {
  const calls: string[] = [];
  let index = 0;
  const reader = {
    async inspect() {
      calls.push('inspect');
      const observed = observations[index++];
      assert.ok(observed);
      return observed;
    },
    async close() { calls.push('close'); },
  };
  const editor: DeliveryPageEditor = {
    ...reader,
    async attachAndSave(attachment) {
      calls.push('attach');
      assert.deepEqual(attachment, {
        localFilePath: order.localFilePath, originalName: order.originalName, sha256: order.sha256,
      });
      if (interruption === 'attach') throw new Error('Interrumpido después de seleccionar el archivo.');
    },
    async submitForGrading() {
      calls.push('submit');
      if (interruption === 'submit') throw new Error('Conexión perdida.');
    },
  };
  const browser: AulaVirtualDeliveryBrowser = {
    async openForSubmission(request) {
      calls.push('edit');
      assert.deepEqual(request, target);
      return { kind: 'opened', page: editor };
    },
    async openForVerification(request) {
      calls.push('read');
      assert.deepEqual(request, target);
      return { kind: 'opened', page: reader };
    },
  };
  return { calls, sender: new AulaVirtualSender({ portalUrl: 'https://aula.example.edu/2026B/', accountId: order.accountId, browser }) };
}

test('envía el PDF exacto desde un borrador propio y registra la confirmación observada', async () => {
  const { calls, sender } = simulate([initial, draft, submitted]);
  assert.deepEqual(await sender.submit(order), {
    state: 'confirmed',
    evidence: { activityUrl, visibleStatus: submitted.visibleStatus, fileName: order.originalName, portalReference: 'recibo-1' },
  });
  assert.deepEqual(calls, ['edit', 'inspect', 'attach', 'inspect', 'submit', 'inspect', 'close']);
});

test('si Moodle confirma al guardar, no pulsa otro botón de envío', async () => {
  const { calls, sender } = simulate([initial, submitted]);
  assert.equal((await sender.submit(order)).state, 'confirmed');
  assert.deepEqual(calls, ['edit', 'inspect', 'attach', 'inspect', 'close']);
});

test('impide cambios con actividad cerrada, borrador existente, cuenta o actividad incorrectas', async () => {
  for (const observed of [
    { ...initial, state: 'closed' as const }, draft,
    { ...initial, accountId: 'otro' }, { ...initial, externalId: '13' },
    { ...initial, activityUrl: 'https://aula.example.edu/otro/mod/assign/view.php?id=12' },
  ]) {
    const { calls, sender } = simulate([observed]);
    assert.equal((await sender.submit(order)).state, 'failed');
    assert.deepEqual(calls, ['edit', 'inspect', 'close']);
  }
});

test('rechaza otra cuenta y enlaces que podrían ejecutar acciones antes de abrir el navegador', async () => {
  const { calls, sender } = simulate([]);
  for (const invalid of [
    { ...order, accountId: 'otro' }, { ...order, localFilePath: 'archivo.pdf' }, { ...order, originalName: '../archivo.pdf' },
    { ...order, activityUrl: activityUrl + '&action=submit' },
    { ...order, activityUrl: activityUrl + '&sesskey=not-a-key' },
    { ...order, activityUrl: activityUrl.replace('/2026B/', '/2025A/') },
    { ...order, activityUrl: activityUrl.replace('aula.example.edu', 'externo.example.edu') },
  ]) assert.equal((await sender.submit(invalid)).state, 'failed');
  assert.deepEqual(calls, []);
});

test('distingue una sesión vencida de un resultado previo todavía incierto', async () => {
  const browser: AulaVirtualDeliveryBrowser = {
    async openForSubmission() { return { kind: 'session_expired' }; },
    async openForVerification() { return { kind: 'session_expired' }; },
  };
  const sender = new AulaVirtualSender({ portalUrl: 'https://aula.example.edu/2026B/', accountId: order.accountId, browser });
  assert.deepEqual(await sender.submit(order), { state: 'failed' });
  assert.deepEqual(await sender.verify(order), { state: 'needs_verification' });
});

test('conserva incertidumbre ante una desconexión o un resultado que aún es borrador', async () => {
  for (const stage of ['attach', 'submit'] as const) {
    const { calls, sender } = simulate([initial, draft], stage);
    assert.equal((await sender.submit(order)).state, 'needs_verification');
    assert.equal(calls.at(-1), 'close');
  }
  const { sender } = simulate([initial, draft, draft]);
  assert.equal((await sender.submit(order)).state, 'needs_verification');
});

test('la verificación solo consulta y requiere evidencia del archivo exacto', async () => {
  const matching = { ...submitted, attachments: [{ name: order.originalName, sha256: order.sha256 }] };
  for (const [observed, state] of [
    [submitted, 'needs_verification'], [draft, 'needs_verification'], [matching, 'confirmed'],
  ] as const) {
    const { calls, sender } = simulate([observed]);
    assert.equal((await sender.verify(order)).state, state);
    assert.deepEqual(calls, ['read', 'inspect', 'close']);
  }
});

test('preserves proofKey and capturedAt in confirmed and needs_verification delivery evidence', async () => {
  const capturedAt = '2026-11-26T08:00:00.000Z';
  const submittedWithProof: DeliveryPageObservation = {
    ...submitted,
    proofKey: 'proof-confirmed-1',
    capturedAt,
  };
  const draftWithProof: DeliveryPageObservation = {
    ...draft,
    proofKey: 'proof-draft-2',
    capturedAt,
  };

  const confirmedSubmit = await simulate([initial, draft, submittedWithProof]).sender.submit(order);
  assert.deepEqual(confirmedSubmit, {
    state: 'confirmed',
    evidence: {
      activityUrl,
      visibleStatus: submittedWithProof.visibleStatus,
      fileName: order.originalName,
      portalReference: 'recibo-1',
      proofKey: 'proof-confirmed-1',
      capturedAt,
    },
  });

  const uncertainSubmit = await simulate([initial, draft, draftWithProof]).sender.submit(order);
  assert.deepEqual(uncertainSubmit, {
    state: 'needs_verification',
    evidence: {
      activityUrl,
      visibleStatus: draftWithProof.visibleStatus,
      fileName: order.originalName,
      portalReference: undefined,
      proofKey: 'proof-draft-2',
      capturedAt,
    },
  });

  const verifiedWithProof = await simulate([
    { ...submittedWithProof, attachments: [{ name: order.originalName, sha256: order.sha256 }] },
  ]).sender.verify(order);
  assert.equal(verifiedWithProof.state, 'confirmed');
  assert.equal(verifiedWithProof.evidence?.proofKey, 'proof-confirmed-1');
  assert.equal(verifiedWithProof.evidence?.capturedAt, capturedAt);

  const uncertainVerify = await simulate([draftWithProof]).sender.verify(order);
  assert.equal(uncertainVerify.state, 'needs_verification');
  assert.equal(uncertainVerify.evidence?.proofKey, 'proof-draft-2');
  assert.equal(uncertainVerify.evidence?.capturedAt, capturedAt);
});

test('verify marks open or closed assignment with zero attachments as definitively failed with evidence', async () => {
  const capturedAt = '2026-11-26T10:00:00.000Z';
  const emptyOpen: DeliveryPageObservation = {
    ...target,
    state: 'open',
    visibleStatus: 'Todavía no se han realizado envíos',
    attachments: [],
    proofKey: 'proof-empty-open',
    capturedAt,
  };
  const emptyClosed: DeliveryPageObservation = {
    ...target,
    state: 'closed',
    visibleStatus: 'No se aceptan entregas',
    attachments: [],
    proofKey: 'proof-empty-closed',
    capturedAt,
  };

  for (const observed of [emptyOpen, emptyClosed]) {
    const { calls, sender } = simulate([observed]);
    const result = await sender.verify(order);
    assert.deepEqual(result, {
      state: 'failed',
      evidence: {
        activityUrl,
        visibleStatus: observed.visibleStatus,
        fileName: undefined,
        portalReference: undefined,
        proofKey: observed.proofKey,
        capturedAt,
      },
    });
    assert.deepEqual(calls, ['read', 'inspect', 'close']);
  }

  // Open or closed with unexpected attachments stays needs_verification instead of falsely failing.
  const openWithFile: DeliveryPageObservation = {
    ...emptyOpen,
    attachments: [{ name: order.originalName }],
  };
  assert.equal((await simulate([openWithFile]).sender.verify(order)).state, 'needs_verification');
});

test('uses editor.hasMutated() to return failed on pre-flight errors and needs_verification after mutation', async () => {
  const runWithEditor = async (mutatedBeforeThrow: boolean) => {
    const calls: string[] = [];
    let mutated = false;
    const editor: DeliveryPageEditor = {
      async inspect() {
        calls.push('inspect');
        return initial;
      },
      async attachAndSave() {
        calls.push('attach');
        mutated = mutatedBeforeThrow;
        throw new Error(mutatedBeforeThrow ? 'Network dropped after saving draft.' : 'Pre-flight control missing.');
      },
      async submitForGrading() {
        calls.push('submit');
      },
      hasMutated() {
        return mutated;
      },
      async close() {
        calls.push('close');
      },
    };
    const browser: AulaVirtualDeliveryBrowser = {
      async openForSubmission() {
        calls.push('edit');
        return { kind: 'opened', page: editor };
      },
      async openForVerification() {
        calls.push('read');
        return { kind: 'opened', page: editor };
      },
    };
    const sender = new AulaVirtualSender({
      portalUrl: 'https://aula.example.edu/2026B/',
      accountId: order.accountId,
      browser,
    });
    const result = await sender.submit(order);
    return { calls, result };
  };

  const preFlight = await runWithEditor(false);
  assert.deepEqual(preFlight.result, { state: 'failed' });
  assert.deepEqual(preFlight.calls, ['edit', 'inspect', 'attach', 'close']);

  const postMutation = await runWithEditor(true);
  assert.deepEqual(postMutation.result, { state: 'needs_verification' });
  assert.deepEqual(postMutation.calls, ['edit', 'inspect', 'attach', 'close']);
});
