import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { VerTarea } from '../../../core/application/tasks';
import { ApplicationError } from '../../../core/domain/model';
import { presentTask } from '../panel.presenter';
import { PANEL_ACCOUNT, PANEL_DEMO } from '../panel.tokens';

@Injectable()
export class TaskPage {
  constructor(
    private readonly detail: VerTarea,
    @Inject(PANEL_ACCOUNT) private readonly accountId: string,
    @Inject(PANEL_DEMO) private readonly demoMode: boolean,
  ) {}

  async view(taskId: string, errors: { uploadError?: string; deliveryError?: string } = {}) {
    try {
      return { task: presentTask(await this.detail.execute(this.accountId, taskId), this.demoMode), demoMode: this.demoMode, ...errors };
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'not_found') throw new NotFoundException(error.message);
      throw error;
    }
  }
}
