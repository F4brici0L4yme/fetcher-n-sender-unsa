import { CaptureResult, DeliveryOrder, DeliveryResult } from '../../domain/model';

export const ASSIGNMENT_FETCHER = Symbol('AssignmentFetcher');
export const ASSIGNMENT_SENDER = Symbol('AssignmentSender');

export interface AssignmentFetcher {
  fetch(order: { jobId: string; accountId: string }): Promise<CaptureResult>;
}

export interface AssignmentSender {
  submit(order: DeliveryOrder): Promise<DeliveryResult>;
  verify(order: DeliveryOrder): Promise<DeliveryResult>;
}
