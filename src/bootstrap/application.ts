import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { engine } from 'express-handlebars';
import { join } from 'node:path';
import { RuntimeConfig } from './config';
import { CoreModule } from './core.module';
import { DemoController } from './dev-demo/demo.controller';

export async function createApplication(config: RuntimeConfig, logger: false | undefined = undefined) {
  @Module({
    imports: [CoreModule.register(config)],
    controllers: config.demoMode ? [DemoController] : [],
  })
  class ApplicationModule {}

  const app = await NestFactory.create<NestExpressApplication>(ApplicationModule, { logger, abortOnError: false });
  if (config.demoMode) {
    app.engine('hbs', engine({ extname: '.hbs', defaultLayout: false }));
    app.setViewEngine('hbs');
    app.setBaseViewsDir(join(__dirname, 'dev-demo', 'views'));
  }
  return app;
}
