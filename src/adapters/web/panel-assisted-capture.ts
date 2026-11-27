import { Inject, Injectable, Optional, type MessageEvent } from '@nestjs/common';
import { concatMap, distinctUntilChanged, map, merge, Observable, of } from 'rxjs';
import { ConsultarRevisionCuenta, ConsultarRevisionTareas } from '../../core/application/assignment-import';
import { TaskChanges } from '../../core/application/ports/persistence';
import { currentAccount, type PanelAccount } from './panel-account';
import { PANEL_ACCOUNT } from './panel.tokens';

export const PANEL_CAPTURE_READY = Symbol('PanelCaptureReady');
export const PANEL_TASK_CHANGES = Symbol('PanelTaskChanges');
export const PANEL_LIVE_CHANGES = Symbol('PanelLiveChanges');

@Injectable()
export class PanelAssistedCapture {
  constructor(
    @Inject(PANEL_ACCOUNT) private readonly account: PanelAccount,
    @Inject(PANEL_CAPTURE_READY) readonly ready: boolean,
    @Inject(PANEL_TASK_CHANGES) private readonly changes: TaskChanges,
    private readonly revisions: ConsultarRevisionTareas,
  ) {}

  currentRevision() {
    return this.revisions.execute(currentAccount(this.account));
  }

  watch(): Observable<MessageEvent> {
    const notifications = new Observable<void>((subscriber) =>
      this.changes.subscribe(() => subscriber.next(), () => subscriber.complete()));
    // Subscribe first, then read the revision to catch commits missed while disconnected.
    return merge(notifications, of(undefined)).pipe(
      concatMap(() => this.currentRevision()),
      distinctUntilChanged(),
      map((revision) => ({ type: 'tasks-version', data: { revision } })),
    );
  }
}

@Injectable()
export class PanelLiveUpdates {
  constructor(
    @Inject(PANEL_ACCOUNT) private readonly account: PanelAccount,
    @Inject(PANEL_LIVE_CHANGES) private readonly changes: TaskChanges,
    @Optional() private readonly revisions?: ConsultarRevisionCuenta,
  ) {}

  async currentRevision(): Promise<string> {
    const accountId = currentAccount(this.account);
    if (!this.revisions) return accountId + ':0';
    return this.revisions.execute(accountId);
  }

  watch(): Observable<MessageEvent> {
    const notifications = new Observable<void>((subscriber) =>
      this.changes.subscribe(() => subscriber.next(), () => subscriber.complete()));
    return merge(notifications, of(undefined)).pipe(
      concatMap(() => this.currentRevision()),
      distinctUntilChanged(),
      map((revision) => ({ type: 'tasks-version', data: { revision } })),
    );
  }
}
