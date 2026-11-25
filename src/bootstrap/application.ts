import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';
import { engine } from 'express-handlebars';
import { join } from 'node:path';
import { PanelModule } from '../adapters/web/panel.module';
import { RuntimeConfig } from './config';
import { CoreModule } from './core.module';

export async function createApplication(config: RuntimeConfig, logger: false | undefined = undefined) {
  const core = CoreModule.register(config);
  @Module({
    imports: [core, PanelModule.register(core, config.accountId, config.demoMode)],
  })
  class ApplicationModule {}

  const app = await NestFactory.create<NestExpressApplication>(ApplicationModule, { logger, abortOnError: false });
  const web = join(__dirname, '..', 'adapters', 'web');
  app.engine('hbs', engine({ extname: '.hbs', defaultLayout: false }));
  app.setViewEngine('hbs');
  app.setBaseViewsDir(join(web, 'views'));
  app.useStaticAssets(join(web, 'public'), { prefix: '/assets/' });
  if (config.demoMode) {
    const express: Express = app.getHttpAdapter().getInstance();
    express.get('/__demo', (_request, response) => response.redirect(302, '/'));
  }
  return app;
}
