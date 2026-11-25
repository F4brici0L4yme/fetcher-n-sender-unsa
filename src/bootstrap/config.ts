import { normalizeAulaPortalUrl } from '../adapters/fetcher/aula-virtual';

export interface AssistedCaptureConfig {
  portalUrl: string;
  portalAccount: string | undefined;
}

export interface RuntimeConfig {
  databaseUrl: string;
  uploadDir: string;
  host: string;
  port: number;
  demoMode: boolean;
  accountId: string;
  assistedCapture?: AssistedCaptureConfig;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  if (!env.DATABASE_URL || !env.UPLOAD_DIR) throw new Error('Configura DATABASE_URL y UPLOAD_DIR.');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT inválido.');
  const demoMode = env.NODE_ENV === 'development' && env.DEMO_MODE === 'true';
  const assistedCapture = env.NODE_ENV === 'development' && env.AULA_CAPTURE_MODE === 'assisted'
    ? {
      portalUrl: normalizeAulaPortalUrl(env.AULA_PORTAL_URL || 'https://aulavirtual.unsa.edu.pe/2026B/'),
      portalAccount: env.AULA_PORTAL_ACCOUNT?.trim() || undefined,
    }
    : undefined;

  if (assistedCapture && demoMode) throw new Error('Elige un solo modo: captura asistida o demo simulada.');
  return {
    databaseUrl: env.DATABASE_URL, uploadDir: env.UPLOAD_DIR, demoMode, port, assistedCapture,
    host: env.HOST || '127.0.0.1',
    accountId: demoMode ? 'demo-local' : env.AULA_ACCOUNT_ID?.trim() || (assistedCapture ? 'aula-unsa' : 'local'),
  };
}
