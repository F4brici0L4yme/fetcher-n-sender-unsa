import { Inject, Injectable, type MessageEvent } from '@nestjs/common';
import { concatMap, distinctUntilChanged, map, merge, Observable, of } from 'rxjs';
import { ConsultarRevisionTareas } from '../../core/application/assignment-import';
import { TaskChanges } from '../../core/application/ports/persistence';
import { PANEL_ACCOUNT } from './panel.tokens';

export const PANEL_CAPTURE_READY = Symbol('PanelCaptureReady');
export const PANEL_TASK_CHANGES = Symbol('PanelTaskChanges');

@Injectable()
export class PanelAssistedCapture {
  constructor(
    @Inject(PANEL_ACCOUNT) private readonly accountId: string,
    @Inject(PANEL_CAPTURE_READY) readonly ready: boolean,
    @Inject(PANEL_TASK_CHANGES) private readonly changes: TaskChanges,
    private readonly revisions: ConsultarRevisionTareas,
  ) {}

  currentRevision() {
    return this.revisions.execute(this.accountId);
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
