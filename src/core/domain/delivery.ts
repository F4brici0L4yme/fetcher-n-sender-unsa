import { ApplicationError, Destination } from './model';

export function requireDeliveryDestination(destination: Destination): void {
  if (destination !== 'aula_virtual') {
    throw new ApplicationError('unsupported_destination', 'La actividad requiere otro destino o el destino es ambiguo.');
  }
}

export function requireCurrentPdfAndAvailableDelivery(pdfIsCurrent: boolean, hasPendingDelivery: boolean): void {
  if (!pdfIsCurrent) throw new ApplicationError('stale_pdf', 'Vuelve a revisar el PDF vigente antes de entregar.');
  if (hasPendingDelivery) throw new ApplicationError('delivery_pending', 'Ya hay una entrega pendiente para esta actividad.');
}
