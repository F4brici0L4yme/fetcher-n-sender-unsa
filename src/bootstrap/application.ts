import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express, { type Express } from 'express';
import { engine } from 'express-handlebars';
import { join } from 'node:path';
import { PostgresTaskChanges } from '../adapters/persistence/task-changes';
import { PanelModule } from '../adapters/web/panel.module';
import { RuntimeConfig } from './config';
import { ACCOUNT_ID, CoreModule } from './core.module';
import { type PanelAccount } from '../adapters/web/panel-account';

export async function createApplication(config: RuntimeConfig, logger: false | undefined = undefined) {
  const core = CoreModule.register(config);
  const assisted = config.assistedCapture ? {
    ready: Boolean(config.assistedCapture.portalAccount),
    changes: new PostgresTaskChanges(config.databaseUrl, config.accountId),
  } : undefined;
  const liveChanges = !assisted
    ? {
      provideChanges: (account: PanelAccount) => new PostgresTaskChanges(config.databaseUrl, account),
    }
    : undefined;
  @Module({
    imports: [core, PanelModule.register(core, ACCOUNT_ID, config.demoMode, assisted, liveChanges)],
  })
  class ApplicationModule {}

  const app = await NestFactory.create<NestExpressApplication>(ApplicationModule, {
    logger,
    abortOnError: false,
    bodyParser: false,
  });
  const expressApp: Express = app.getHttpAdapter().getInstance();
  const defaultJson = express.json({ limit: '1mb' });
  const mcpJson = express.json({ limit: '28mb' });
  expressApp.use((request, response, next) => (
    request.path === '/mcp' ? mcpJson(request, response, next) : defaultJson(request, response, next)
  ));
  expressApp.use(express.urlencoded({ extended: true, limit: '1mb' }));
  const web = join(__dirname, '..', 'adapters', 'web');
  app.engine('hbs', engine({ extname: '.hbs', defaultLayout: false }));
  app.setViewEngine('hbs');
  app.setBaseViewsDir(join(web, 'views'));
  app.useStaticAssets(join(web, 'public'), { prefix: '/assets/' });
  if (config.demoMode) {
    expressApp.get('/__demo', (_request, response) => response.redirect(302, '/'));
  }
  return app;
}
