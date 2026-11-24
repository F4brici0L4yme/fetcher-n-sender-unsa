import { AssignmentFetcher, AssignmentSender } from '../../core/application/ports/academic';

export const simulatedFetcher: AssignmentFetcher = {
  async fetch() {
    return {
      kind: 'success',
      assignments: [{
        externalId: 'demo-1', title: 'Práctica de prueba', course: 'Curso de demostración',
        activityUrl: 'https://aula.example.invalid/mod/assign/view.php?id=1',
        deadline: null, destination: 'aula_virtual',
      }],
    };
  },
};

export const simulatedSender: AssignmentSender = {
  async submit(order) {
    return {
      state: 'confirmed',
      evidence: {
        activityUrl: order.activityUrl, fileName: order.originalName,
        visibleStatus: 'Entrega simulada confirmada', portalReference: order.jobId,
      },
    };
  },
  async verify() {
    return { state: 'needs_verification' };
  },
};
