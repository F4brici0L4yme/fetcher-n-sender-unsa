export type Destination = 'aula_virtual' | 'other' | 'unknown';

export interface CapturedAssignment {
  externalId: string;
  course: string;
  title: string;
  activityUrl: string;
  deadline: string | null;
  destination: Destination;
}

export interface PdfSummary {
  pdfId: string;
  originalName: string;
  sha256: string;
}

export interface StoredPdf extends PdfSummary {
  storageKey: string;
  sizeBytes: number;
}

export interface DeliveryEvidence {
  activityUrl: string;
  visibleStatus: string;
  fileName?: string;
  portalReference?: string;
}

export type SearchState = 'queued' | 'running' | 'completed' | 'failed';
export type DeliveryState = 'authorized' | 'running' | 'confirmed' | 'failed' | 'needs_verification';

export type JobView =
  | { jobId: string; kind: 'search'; state: SearchState; summary: string | null }
  | { jobId: string; kind: 'delivery'; state: DeliveryState; summary: string | null; evidence: DeliveryEvidence | null };

export interface TaskView extends CapturedAssignment {
  taskId: string;
  currentPdf: PdfSummary | null;
  delivery: Extract<JobView, { kind: 'delivery' }> | null;
}

export interface DeliveryOrder extends PdfSummary {
  jobId: string;
  accountId: string;
  externalId: string;
  activityUrl: string;
  localFilePath: string;
}

export interface StoredDeliveryOrder extends Omit<DeliveryOrder, 'localFilePath'> {
  storageKey: string;
}

export type CaptureResult =
  | { kind: 'success'; assignments: CapturedAssignment[] }
  | { kind: 'session_expired' | 'unavailable' | 'failed' };

export type DeliveryResult =
  | { state: 'confirmed'; evidence: DeliveryEvidence }
  | { state: 'failed' | 'needs_verification'; evidence?: DeliveryEvidence };

export class ApplicationError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_capture' | 'invalid_pdf' | 'stale_pdf'
      | 'unsupported_destination' | 'delivery_pending' | 'delivery_not_uncertain',
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}
