import { AulaVirtualFetcher } from '../../adapters/fetcher/aula-virtual';
import { DeliveryPageObservation } from '../../adapters/sender/aula-virtual-delivery-browser';
import { AulaVirtualSender } from '../../adapters/sender/aula-virtual-sender';

const portalUrl = 'https://aula.example.invalid/';
const activityUrl = new URL('mod/assign/view.php?id=1', portalUrl).href;

export function createSimulatedAcademic(accountId: string) {
  const fetcher = new AulaVirtualFetcher({
    portalUrl, accountId,
    runner: {
      async capture() {
        return {
          kind: 'success', observedAccountId: accountId, assignments: [{
            externalId: 'demo-1', title: 'Práctica de prueba', course: 'Curso de demostración',
            activityUrl, deadline: null, destination: 'aula_virtual',
          }],
        };
      },
    },
  });
  const sender = new AulaVirtualSender({
    portalUrl, accountId,
    browser: {
      async openForSubmission(target) {
        let observation: DeliveryPageObservation = {
          ...target, state: 'open', visibleStatus: 'Sin envío', attachments: [],
        };
        return {
          kind: 'opened',
          page: {
            async inspect() { return observation; },
            async attachAndSave({ originalName, sha256 }) {
              observation = {
                ...observation, state: 'draft', visibleStatus: 'Borrador',
                attachments: [{ name: originalName, sha256 }],
              };
            },
            async submitForGrading() {
              observation = {
                ...observation, state: 'submitted', visibleStatus: 'Entrega simulada confirmada',
                portalReference: target.jobId,
              };
            },
            async close() {},
          },
        };
      },
      async openForVerification() { return { kind: 'unavailable' }; },
    },
  });
  return { fetcher, sender };
}
