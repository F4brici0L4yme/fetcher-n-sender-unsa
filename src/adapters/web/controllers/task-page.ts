import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ListarPropuestasAgente, PoliticaAutomatizacion } from '../../../core/application/agent';
import { PersonalNotes } from '../../../core/application/notes';
import { AUTO_SYNC_MONITOR, type AutoSyncMonitor } from '../../../core/application/ports/agent';
import { PERSONAL_SESSION, type PersonalSession } from '../../../core/application/ports/browser-session';
import { ListarTareas, VerTarea } from '../../../core/application/tasks';
import { ApplicationError } from '../../../core/domain/model';
import { currentAccount, type PanelAccount } from '../panel-account';
import { PanelAssistedCapture, PanelLiveUpdates } from '../panel-assisted-capture';
import { presentAutoSync, presentSession, presentSidebar, presentTask } from '../panel.presenter';
import { PANEL_ACCOUNT, PANEL_DEMO } from '../panel.tokens';

@Injectable()
export class TaskPage {
  constructor(
    private readonly detail: VerTarea,
    @Inject(PANEL_ACCOUNT) private readonly account: PanelAccount,
    @Inject(PANEL_DEMO) private readonly demoMode: boolean,
    @Optional() private readonly assisted?: PanelAssistedCapture,
    @Optional() private readonly live?: PanelLiveUpdates,
    @Optional() private readonly notes?: PersonalNotes,
    @Optional() @Inject(PERSONAL_SESSION) private readonly session?: PersonalSession,
    @Optional() private readonly list?: ListarTareas,
    @Optional() private readonly proposals?: ListarPropuestasAgente,
    @Optional() private readonly policy?: PoliticaAutomatizacion,
    @Optional() @Inject(AUTO_SYNC_MONITOR) private readonly autoSync?: AutoSyncMonitor,
  ) {}

  async view(taskId: string, errors: { uploadError?: string; deliveryError?: string } = {}) {
    const accountId = currentAccount(this.account);
    try {
      const liveRevision = this.assisted ? null : (await this.live?.currentRevision() ?? null);
      const [task, tasks, noteList, sessionStatus, proposalList] = await Promise.all([
        this.detail.execute(accountId, taskId),
        this.list ? this.list.execute(accountId) : Promise.resolve(null),
        this.notes ? this.notes.list(accountId) : Promise.resolve(null),
        this.session ? this.session.status() : Promise.resolve(null),
        this.proposals ? this.proposals.execute(accountId, 20) : Promise.resolve(null),
      ]);
      const session = presentSession(sessionStatus);
      const autoSync = presentAutoSync(this.autoSync?.status());
      const completedCount = (noteList ? noteList.filter((n) => n.status === 'completado').length : 0)
        + (tasks ? tasks.filter((t) => t.delivery?.state === 'confirmed').length : 0);

      return {
        accountId,
        task: presentTask(task, this.demoMode),
        demoMode: this.demoMode,
        assistedCapture: Boolean(this.assisted),
        liveRevision,
        autoSync,
        sidebar: presentSidebar({
          active: 'tareas',
          notesEnabled: Boolean(this.notes),
          agentEnabled: Boolean(!this.assisted && this.policy),
          session,
          autoSync,
          demoMode: this.demoMode,
          assistedMode: Boolean(this.assisted),
          liveActive: Boolean(this.live),
          counts: {
            tasks: tasks ? tasks.filter((t) => t.delivery?.state !== 'confirmed').length : undefined,
            notes: noteList ? noteList.filter((n) => n.status !== 'completado').length : undefined,
            completed: tasks || noteList ? completedCount : undefined,
            proposals: proposalList ? proposalList.filter((p) => p.state === 'pending').length : undefined,
          },
        }),
        ...errors,
      };
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'not_found') throw new NotFoundException(error.message);
      throw error;
    }
  }
}
