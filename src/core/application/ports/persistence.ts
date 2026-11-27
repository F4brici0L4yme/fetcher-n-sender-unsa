import {
  CapturedAssignment, DeliveryEvidence, DeliveryState, JobView,
  StoredDeliveryOrder, StoredPdf, TaskView,
} from '../../domain/model';

export interface TaskRepository {
  list(accountId: string): Promise<TaskView[]>;
  find(accountId: string, taskId: string): Promise<TaskView | null>;
  attachPdf(accountId: string, taskId: string, pdf: StoredPdf): Promise<void>;
}

export interface JobRepository {
  queueSearch(accountId: string): Promise<string>;
  authorizeDelivery(accountId: string, taskId: string, pdfId: string): Promise<string>;
  requestVerification(accountId: string, jobId: string): Promise<void>;
  discardDelivery(accountId: string, taskId: string, jobId: string): Promise<{ proofStorageKey: string | null }>;
  find(accountId: string, jobId: string): Promise<JobView | null>;
}

export interface SearchHistory {
  latestSearch(accountId: string): Promise<Extract<JobView, { kind: 'search' }> | null>;
}

export interface AssignmentImportRepository {
  recordImport(accountId: string, assignments: CapturedAssignment[]): Promise<{ jobId: string; updatedTasks: number }>;
  latestCompletedSearchId(accountId: string): Promise<string | null>;
}

export interface AccountRevisionRepository {
  currentRevision(accountId: string): Promise<string>;
}

export interface TaskChanges {
  subscribe(onChange: () => void, onClose: () => void): () => void;
}

export interface PdfStore {
  write(content: Uint8Array): Promise<Omit<StoredPdf, 'originalName'>>;
  discard(storageKey: string): Promise<void>;
  path(storageKey: string): string;
  verifiedPath(storageKey: string, sha256: string): Promise<string>;
}

export interface ProofStore {
  writePng(content: Uint8Array): Promise<string>;
  readPng(storageKey: string): Promise<Uint8Array | null>;
  discard(storageKey: string): Promise<void>;
}

export type ClaimedWork =
  | { kind: 'search'; jobId: string }
  | { kind: 'delivery'; order: StoredDeliveryOrder }
  | { kind: 'verification'; order: StoredDeliveryOrder };

export interface WorkerRepository {
  withAccountLock(accountId: string, run: (worker: WorkerSession) => Promise<void>): Promise<void>;
}

export interface WorkerSession {
  recoverInterrupted(): Promise<void>;
  claimNext(): Promise<ClaimedWork | null>;
  completeSearch(jobId: string, assignments: CapturedAssignment[]): Promise<void>;
  failSearch(jobId: string, summary: string): Promise<void>;
  settleDelivery(
    jobId: string, expected: 'running' | 'needs_verification',
    state: Extract<DeliveryState, 'confirmed' | 'failed' | 'needs_verification'>,
    summary: string, evidence?: DeliveryEvidence,
  ): Promise<void>;
}
