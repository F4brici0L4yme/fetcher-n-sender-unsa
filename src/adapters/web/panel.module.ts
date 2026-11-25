import { DynamicModule, Module } from '@nestjs/common';
import { PanelController } from './controllers/panel.controller';
import { TaskPage } from './controllers/task-page';
import { PANEL_ACCOUNT, PANEL_DEMO } from './panel.tokens';
import { PanelWriteGuard } from './panel-write.guard';
import { PdfUploadErrorFilter } from './controllers/pdf-upload.filter';

@Module({})
export class PanelModule {
  static register(core: DynamicModule, accountId: string, demoMode: boolean): DynamicModule {
    return {
      module: PanelModule,
      imports: [core],
      controllers: [PanelController],
      providers: [
        TaskPage, PdfUploadErrorFilter, PanelWriteGuard,
        { provide: PANEL_ACCOUNT, useValue: accountId },
        { provide: PANEL_DEMO, useValue: demoMode },
      ],
    };
  }
}
