import 'reflect-metadata';
import { createApplication } from './application';
import { readConfig } from './config';

async function main() {
  const config = readConfig();
  const app = await createApplication(config);
  app.enableShutdownHooks();
  try {
    await app.listen(config.port, config.host);
  } catch (error) {
    await app.close();
    throw error;
  }
}

void main().catch(() => {
  console.error('No se pudo iniciar la aplicación. Revisa la configuración y las migraciones.');
  process.exitCode = 1;
});
