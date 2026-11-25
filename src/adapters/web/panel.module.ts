import { DynamicModule, Module, type Provider } from '@nestjs/common';
import { PanelController } from './controllers/panel.controller';
import { TaskChanges } from '../../core/application/ports/persistence';
import { PANEL_CAPTURE_READY, PANEL_TASK_CHANGES, PanelAssistedCapture } from './panel-assisted-capture';
import { TaskPage } from './controllers/task-page';
import { PANEL_ACCOUNT, PANEL_DEMO } from './panel.tokens';
import { PanelWriteGuard } from './panel-write.guard';
import { PdfUploadErrorFilter } from './controllers/pdf-upload.filter';

@Module({})
export class PanelModule {
  static register(
    core: DynamicModule, accountId: string, demoMode: boolean,
    assisted?: { ready: boolean; changes: TaskChanges },
  ): DynamicModule {
    const captureProviders: Provider[] = assisted ? [
      PanelAssistedCapture,
      { provide: PANEL_CAPTURE_READY, useValue: assisted.ready },
      { provide: PANEL_TASK_CHANGES, useValue: assisted.changes },
    ] : [];
    return {
      module: PanelModule,
      imports: [core],
      controllers: [PanelController],
      providers: [
        TaskPage, PdfUploadErrorFilter, PanelWriteGuard, ...captureProviders,
        { provide: PANEL_ACCOUNT, useValue: accountId },
        { provide: PANEL_DEMO, useValue: demoMode },
      ],
    };
  }
}
