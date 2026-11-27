import { DynamicModule, Module, type Provider } from '@nestjs/common';
import { AgentApiController } from './controllers/agent-api.controller';
import { McpHttpController } from './controllers/mcp-http.controller';
import { NotesController } from './controllers/notes.controller';
import { PanelController } from './controllers/panel.controller';
import { TaskChanges } from '../../core/application/ports/persistence';
import {
  PANEL_CAPTURE_READY, PANEL_LIVE_CHANGES, PANEL_TASK_CHANGES, PanelAssistedCapture, PanelLiveUpdates,
} from './panel-assisted-capture';
import { type PanelAccount } from './panel-account';
import { TaskPage } from './controllers/task-page';
import { PANEL_ACCOUNT, PANEL_DEMO } from './panel.tokens';
import { PanelWriteGuard } from './panel-write.guard';
import { PdfUploadErrorFilter } from './controllers/pdf-upload.filter';

@Module({})
export class PanelModule {
  static register(
    core: DynamicModule,
    account: PanelAccount | symbol,
    demoMode: boolean,
    assisted?: { ready: boolean; changes: TaskChanges },
    live?: { provideChanges: (account: PanelAccount) => TaskChanges },
  ): DynamicModule {
    const captureProviders: Provider[] = assisted ? [
      PanelAssistedCapture,
      { provide: PANEL_CAPTURE_READY, useValue: assisted.ready },
      { provide: PANEL_TASK_CHANGES, useValue: assisted.changes },
    ] : [];
    const liveProviders: Provider[] = live ? [
      PanelLiveUpdates,
      {
        provide: PANEL_LIVE_CHANGES,
        inject: [PANEL_ACCOUNT],
        useFactory: (resolved: PanelAccount) => live.provideChanges(resolved),
      },
    ] : [];
    const accountProvider: Provider = typeof account === 'symbol'
      ? { provide: PANEL_ACCOUNT, useExisting: account }
      : { provide: PANEL_ACCOUNT, useValue: account };
    return {
      module: PanelModule,
      imports: [core],
      controllers: [PanelController, NotesController, AgentApiController, McpHttpController],
      providers: [
        TaskPage, PdfUploadErrorFilter, PanelWriteGuard, ...captureProviders, ...liveProviders,
        accountProvider,
        { provide: PANEL_DEMO, useValue: demoMode },
      ],
    };
  }
}
