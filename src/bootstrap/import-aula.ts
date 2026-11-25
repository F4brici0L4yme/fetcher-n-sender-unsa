import { Pool } from 'pg';
import { readAulaCapture } from '../adapters/fetcher/aula-virtual';
import { postgresDatabase, PostgresAssignmentImportRepository } from '../adapters/persistence/repositories';
import { ImportarTareasObservadas } from '../core/application/assignment-import';
import { readConfig } from './config';

async function readJson(): Promise<unknown> {
  const limit = 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > limit) throw new Error('La captura supera el límite de 1 MiB.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('El comando espera una captura JSON válida por entrada estándar.');
  }
}

async function main() {
  const { accountId, assistedCapture, databaseUrl } = readConfig();
  if (!assistedCapture?.portalAccount) {
    throw new Error('Activa el modo asistido y configura AULA_PORTAL_ACCOUNT antes de importar.');
  }

  const capture = readAulaCapture(await readJson(), assistedCapture.portalUrl, assistedCapture.portalAccount, new Date());
  if (capture.kind !== 'success') {
    throw new Error(capture.kind === 'session_expired'
      ? 'La sesión de Aula Virtual venció. No se guardó ninguna tarea.'
      : 'La captura está incompleta o la cuenta, los enlaces o los plazos no coinciden. No se guardó ninguna tarea.');
  }

  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    const imports = new ImportarTareasObservadas(new PostgresAssignmentImportRepository(postgresDatabase(pool)));
    const result = await imports.execute(accountId, capture.assignments);
    console.log(JSON.stringify(result));
  } catch {
    throw new Error('No se pudo confirmar la importación en PostgreSQL. Consulta el panel antes de reintentar.');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'No se pudo importar la captura.');
  process.exitCode = 1;
});
