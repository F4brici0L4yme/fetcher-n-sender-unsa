import { AssignmentFetcher } from '../../core/application/ports/academic';
import { normalizeDeadline, visibleDeadline } from '../../core/domain/deadline';
import { CapturedAssignment, CaptureResult, Destination } from '../../core/domain/model';

export interface VisualCaptureRequest {
  jobId: string;
  accountId: string;
  portalUrl: string;
  readOnly: true;
}

export interface VisualCaptureRunner {
  capture(request: VisualCaptureRequest): Promise<unknown>;
}

export interface AulaVirtualFetcherOptions {
  portalUrl: string;
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

function parseAssignment(value: unknown, portalUrl: string): CapturedAssignment {
  const data = record(value);
  if (!data) throw new Error('Invalid assignment');
  const url = new URL(requiredText(data.activityUrl));
  const expected = new URL('mod/assign/', portalUrl);
  if (url.origin !== expected.origin || url.protocol !== 'https:' || url.username || url.password
    || !url.pathname.startsWith(expected.pathname)) throw new Error('Unexpected activity URL');
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
  private readonly portalUrl: string;
  private readonly clock: () => Date;

  constructor(private readonly options: AulaVirtualFetcherOptions) {
    const portal = new URL(options.portalUrl);
    if (portal.protocol !== 'https:' || portal.username || portal.password || portal.pathname.startsWith('//')) {
      throw new Error('Aula Virtual portalUrl must be an HTTPS URL');
    }
    const basePath = portal.pathname.endsWith('/') ? portal.pathname : `${portal.pathname}/`;
    portal.pathname = basePath;
    portal.search = '';
    portal.hash = '';
    this.portalUrl = portal.href;
    this.clock = options.clock ?? (() => new Date());
  }

  async fetch(order: { jobId: string; accountId: string }): Promise<CaptureResult> {
    if (order.accountId !== this.options.accountId) return { kind: 'failed' };
    if (!this.options.runner) return { kind: 'unavailable' };

    try {
      const response = record(await this.options.runner.capture({
        jobId: order.jobId, accountId: order.accountId, portalUrl: this.portalUrl, readOnly: true,
      }));
      if (!response) return { kind: 'failed' };
      if (response.kind === 'session_expired' || response.kind === 'unavailable' || response.kind === 'failed') {
        return { kind: response.kind };
      }
      if (response.kind !== 'success' || response.observedAccountId !== order.accountId
        || !Array.isArray(response.assignments)) return { kind: 'failed' };
      const now = this.clock();
      const assignments = response.assignments.map((item) => parseAssignment(item, this.portalUrl))
        .filter((item) => visibleDeadline(item.deadline, now));
      return { kind: 'success', assignments };
    } catch {
      return { kind: 'failed' };
    }
  }
}
