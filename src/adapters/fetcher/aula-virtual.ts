import { AssignmentFetcher } from '../../core/application/ports/academic';
import { normalizeDeadline, visibleDeadline } from '../../core/domain/deadline';
import { CapturedAssignment, CaptureResult, Destination } from '../../core/domain/model';

export interface VisualCaptureRequest {
  jobId: string;
  accountId: string;
  portalOrigin: string;
  readOnly: true;
}

export interface VisualCaptureRunner {
  capture(request: VisualCaptureRequest): Promise<unknown>;
}

export interface AulaVirtualFetcherOptions {
  portalOrigin: string;
  accountId: string;
  runner: VisualCaptureRunner | null;
  clock?: () => Date;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Invalid capture text');
  return value.trim();
}

function parseAssignment(value: unknown, portalOrigin: string): CapturedAssignment {
  const data = record(value);
  if (!data) throw new Error('Invalid assignment');
  const url = new URL(requiredText(data.activityUrl));
  if (url.origin !== portalOrigin || url.protocol !== 'https:' || url.username || url.password
    || !url.pathname.startsWith('/mod/assign/')) throw new Error('Unexpected activity URL');
  if (data.deadline !== null && typeof data.deadline !== 'string') throw new Error('Invalid deadline');
  if (typeof data.destination !== 'string'
    || !['aula_virtual', 'other', 'unknown'].includes(data.destination)) throw new Error('Invalid destination');

  return {
    externalId: requiredText(data.externalId),
    course: requiredText(data.course),
    title: requiredText(data.title),
    activityUrl: url.href,
    deadline: normalizeDeadline(data.deadline),
    destination: data.destination as Destination,
  };
}

export class AulaVirtualFetcher implements AssignmentFetcher {
  private readonly portalOrigin: string;
  private readonly clock: () => Date;

  constructor(private readonly options: AulaVirtualFetcherOptions) {
    const portal = new URL(options.portalOrigin);
    if (portal.protocol !== 'https:' || portal.origin !== options.portalOrigin || portal.username || portal.password) {
      throw new Error('Aula Virtual portalOrigin must be an HTTPS origin');
    }
    this.portalOrigin = portal.origin;
    this.clock = options.clock ?? (() => new Date());
  }

  async fetch(order: { jobId: string; accountId: string }): Promise<CaptureResult> {
    if (order.accountId !== this.options.accountId) return { kind: 'failed' };
    if (!this.options.runner) return { kind: 'unavailable' };

    try {
      const response = record(await this.options.runner.capture({
        jobId: order.jobId, accountId: order.accountId, portalOrigin: this.portalOrigin, readOnly: true,
      }));
      if (!response) return { kind: 'failed' };
      if (response.kind === 'session_expired' || response.kind === 'unavailable' || response.kind === 'failed') {
        return { kind: response.kind };
      }
      if (response.kind !== 'success' || response.observedAccountId !== order.accountId
        || !Array.isArray(response.assignments)) return { kind: 'failed' };
      const now = this.clock();
      const assignments = response.assignments.map((item) => parseAssignment(item, this.portalOrigin))
        .filter((item) => visibleDeadline(item.deadline, now));
      return { kind: 'success', assignments };
    } catch {
      return { kind: 'failed' };
    }
  }
}
