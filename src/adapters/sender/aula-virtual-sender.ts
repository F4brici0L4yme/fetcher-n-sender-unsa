import { isAbsolute } from 'node:path';
import { AssignmentSender } from '../../core/application/ports/academic';
import { DeliveryEvidence, DeliveryOrder, DeliveryResult } from '../../core/domain/model';
import {
  AulaVirtualDeliveryBrowser, DeliveryPageEditor, DeliveryPageObservation, DeliveryPageReader, DeliveryTarget,
} from './aula-virtual-delivery-browser';

export interface AulaVirtualSenderOptions {
  portalUrl: string;
  accountId: string;
  browser: AulaVirtualDeliveryBrowser | null;
}

export class AulaVirtualSender implements AssignmentSender {
  private readonly assignmentsUrl: URL;

  constructor(private readonly options: AulaVirtualSenderOptions) {
    const portal = URL.parse(options.portalUrl);
    if (!portal || portal.protocol !== 'https:' || portal.username || portal.password
      || portal.pathname.startsWith('//') || !options.accountId.trim()) {
      throw new Error('Configura la cuenta y URL HTTPS del periodo de Aula Virtual.');
    }
    if (!portal.pathname.endsWith('/')) portal.pathname += '/';
    this.assignmentsUrl = new URL('mod/assign/', portal);
  }

  async submit(order: DeliveryOrder): Promise<DeliveryResult> {
    const target = this.target(order);
    if (!target || !this.options.browser || !isAbsolute(order.localFilePath)
      || !order.originalName.trim() || /[\\/\x00-\x1f\x7f]/.test(order.originalName)
      || !/^[a-f0-9]{64}$/.test(order.sha256)) return { state: 'failed' };

    let page: DeliveryPageReader | undefined;
    let editor: DeliveryPageEditor | undefined;
    let mayHaveChanged = false;
    try {
      const opened = await this.options.browser.openForSubmission(target);
      if (opened.kind !== 'opened') return { state: 'failed' };
      editor = opened.page;
      page = editor;
      const initial = await editor.inspect();
      if (!this.matches(initial, target)) return { state: 'failed' };
      if (initial.state === 'submitted') return this.observedResult(initial, order, true);
      if (!['open', 'draft'].includes(initial.state) || initial.attachments.length !== 0) {
        return { state: 'failed', evidence: this.evidence(initial, order) };
      }

      mayHaveChanged = true;
      await editor.attachAndSave({
        localFilePath: order.localFilePath, originalName: order.originalName, sha256: order.sha256,
      });
      const saved = await editor.inspect();
      if (!this.matches(saved, target)) return { state: 'needs_verification' };
      if (saved.state === 'submitted') return this.observedResult(saved, order, false);
      if (saved.state !== 'draft' || !this.matchesPdf(saved, order, false)) {
        return { state: 'needs_verification', evidence: this.evidence(saved, order) };
      }

      await editor.submitForGrading();
      const submitted = await editor.inspect();
      return this.matches(submitted, target) ? this.observedResult(submitted, order, false) : { state: 'needs_verification' };
    } catch {
      const mutated = mayHaveChanged
        ? (typeof editor?.hasMutated === 'function' ? editor.hasMutated() : mayHaveChanged)
        : false;
      return { state: mutated ? 'needs_verification' : 'failed' };
    } finally {
      await this.close(page);
    }
  }

  async verify(order: DeliveryOrder): Promise<DeliveryResult> {
    const target = this.target(order);
    if (!target || !this.options.browser) return { state: 'needs_verification' };

    let page: DeliveryPageReader | undefined;
    try {
      const opened = await this.options.browser.openForVerification(target);
      if (opened.kind !== 'opened') return { state: 'needs_verification' };
      page = opened.page;
      const observed = await page.inspect();
      if (!this.matches(observed, target)) return { state: 'needs_verification' };
      if ((observed.state === 'open' || observed.state === 'closed') && observed.attachments.length === 0) {
        return { state: 'failed', evidence: this.evidence(observed, order) };
      }
      return this.observedResult(observed, order, true);
    } catch {
      return { state: 'needs_verification' };
    } finally {
      await this.close(page);
    }
  }

  private target(order: DeliveryOrder): DeliveryTarget | null {
    if (order.accountId !== this.options.accountId || !order.jobId.trim() || !order.externalId.trim()
      || !this.activityUrl(order.activityUrl)) return null;
    const { jobId, accountId, externalId, activityUrl } = order;
    return { jobId, accountId, externalId, activityUrl };
  }

  private activityUrl(value: string): string | null {
    const url = URL.parse(value);
    if (!url || url.origin !== this.assignmentsUrl.origin || url.username || url.password) return null;
    const name = url.pathname.slice(this.assignmentsUrl.pathname.length);
    if (!url.pathname.startsWith(this.assignmentsUrl.pathname) || !['view.php', 'submission.php'].includes(name)) return null;
    if (Array.from(url.searchParams.keys()).some((key) => !['id', 'submissionid', 'action'].includes(key))
      || url.searchParams.getAll('id').length > 1 || url.searchParams.getAll('submissionid').length > 1) return null;
    const actions = url.searchParams.getAll('action');
    if (actions.length > 1 || actions.some((action) => action !== 'view')) return null;
    const ids = [...url.searchParams.getAll('id'), ...url.searchParams.getAll('submissionid')];
    if (!ids.length || ids.some((id) => !/^[1-9]\d*$/.test(id))) return null;
    url.hash = '';
    url.searchParams.delete('action');
    url.searchParams.sort();
    return url.href;
  }

  private matches(observed: DeliveryPageObservation, target: DeliveryTarget): boolean {
    return observed.accountId === target.accountId && observed.externalId === target.externalId
      && this.activityUrl(observed.activityUrl) === this.activityUrl(target.activityUrl);
  }

  private matchesPdf(observed: DeliveryPageObservation, order: DeliveryOrder, requireHash: boolean): boolean {
    const file = observed.attachments[0];
    return observed.attachments.length === 1 && file?.name === order.originalName
      && (file.sha256 === order.sha256 || (!requireHash && file.sha256 === undefined));
  }

  private evidence(observed: DeliveryPageObservation, order: DeliveryOrder): DeliveryEvidence | undefined {
    if (!observed.visibleStatus.trim()) return undefined;
    return {
      activityUrl: order.activityUrl, visibleStatus: observed.visibleStatus,
      fileName: observed.attachments.length === 1 ? observed.attachments[0]?.name : undefined,
      portalReference: observed.portalReference,
      ...(observed.proofKey ? { proofKey: observed.proofKey } : {}),
      ...(observed.capturedAt ? { capturedAt: observed.capturedAt } : {}),
    };
  }

  private observedResult(observed: DeliveryPageObservation, order: DeliveryOrder, requireHash: boolean): DeliveryResult {
    const evidence = this.evidence(observed, order);
    if (observed.state === 'submitted' && evidence && this.matchesPdf(observed, order, requireHash)) {
      return { state: 'confirmed', evidence };
    }
    return { state: 'needs_verification', evidence };
  }

  private async close(page?: DeliveryPageReader): Promise<void> {
    try {
      await page?.close();
    } catch {
      // Closing the owned tab does not change the portal result already observed.
    }
  }
}
