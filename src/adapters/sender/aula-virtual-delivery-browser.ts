import type { DeliveryOrder } from '../../core/domain/model';

export type DeliveryTarget = Pick<DeliveryOrder, 'jobId' | 'accountId' | 'externalId' | 'activityUrl'>;
export type AuthorizedAttachment = Pick<DeliveryOrder, 'localFilePath' | 'originalName' | 'sha256'>;

export interface DeliveryPageObservation {
  accountId: string;
  externalId: string;
  activityUrl: string;
  state: 'open' | 'closed' | 'draft' | 'submitted' | 'unknown';
  visibleStatus: string;
  attachments: readonly { name: string; sha256?: string }[];
  portalReference?: string;
  proofKey?: string;
  capturedAt?: string;
}

export interface DeliveryPageReader {
  inspect(): Promise<DeliveryPageObservation>;
  close(): Promise<void>;
}

export interface DeliveryPageEditor extends DeliveryPageReader {
  attachAndSave(attachment: AuthorizedAttachment): Promise<void>;
  submitForGrading(): Promise<void>;
}

type OpenResult<Page> = { kind: 'opened'; page: Page } | { kind: 'unavailable' | 'session_expired' | 'failed' };

export interface AulaVirtualDeliveryBrowser {
  openForSubmission(target: DeliveryTarget): Promise<OpenResult<DeliveryPageEditor>>;
  openForVerification(target: DeliveryTarget): Promise<OpenResult<DeliveryPageReader>>;
}
