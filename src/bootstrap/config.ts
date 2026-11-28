import { normalizeAulaPortalUrl } from '../adapters/fetcher/aula-virtual';

export interface AssistedCaptureConfig {
  portalUrl: string;
  portalAccount: string | undefined;
}

export interface PersonalBrowserConfig {
  portalUrl: string;
  profileDir: string;
  accountNamespace: string;
  portalAccount: string | undefined;
  display: string;
  viewerPort: number;
  executablePath?: string;
}

export interface RuntimeConfig {
  databaseUrl: string;
  uploadDir: string;
  proofDir?: string;
  host: string;
  port: number;
  demoMode: boolean;
  accountId: string;
  autoSyncIntervalSeconds?: number;
  assistedCapture?: AssistedCaptureConfig;
  personalBrowser?: PersonalBrowserConfig;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  if (!env.DATABASE_URL || !env.UPLOAD_DIR) throw new Error('Configura DATABASE_URL y UPLOAD_DIR.');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT inválido.');
  const demoMode = env.NODE_ENV === 'development' && env.DEMO_MODE === 'true';
  const mode = env.AULA_CAPTURE_MODE?.trim();
  const portalUrl = normalizeAulaPortalUrl(env.AULA_PORTAL_URL || 'https://aulavirtual.unsa.edu.pe/2026B/');
  const portalAccount = env.AULA_PORTAL_ACCOUNT?.trim() || undefined;
  const assistedCapture = env.NODE_ENV === 'development' && mode === 'assisted'
    ? { portalUrl, portalAccount }
    : undefined;
  const viewerPort = Number(env.LOGIN_VIEWER_PORT ?? 6080);
  if (!Number.isInteger(viewerPort) || viewerPort < 1 || viewerPort > 65535) throw new Error('LOGIN_VIEWER_PORT inválido.');
  const accountNamespace = env.AULA_ACCOUNT_ID?.trim() || 'aula-unsa';
  const personalBrowser = mode === 'browser' && env.SESSION_DIR?.trim()
    ? {
      portalUrl,
      profileDir: env.SESSION_DIR.trim(),
      accountNamespace,
      portalAccount,
      display: env.DISPLAY?.trim() || ':99',
      viewerPort,
      ...(env.CHROMIUM_EXECUTABLE_PATH?.trim() ? { executablePath: env.CHROMIUM_EXECUTABLE_PATH.trim() } : {}),
    }
    : undefined;

  if ((assistedCapture ? 1 : 0) + (personalBrowser ? 1 : 0) + (demoMode ? 1 : 0) > 1) {
    throw new Error('Elige un solo modo: captura asistida, navegador personal o demo simulada.');
  }
  const rawAutoSync = env.AULA_AUTO_SYNC_INTERVAL_SECONDS?.trim();
  const autoSyncIntervalSeconds = rawAutoSync !== undefined && rawAutoSync !== ''
    ? Number(rawAutoSync)
    : (personalBrowser ? 180 : 0);
  if (!Number.isInteger(autoSyncIntervalSeconds) || (autoSyncIntervalSeconds !== 0 && (autoSyncIntervalSeconds < 30 || autoSyncIntervalSeconds > 86400))) {
    throw new Error('AULA_AUTO_SYNC_INTERVAL_SECONDS debe ser 0 o un entero entre 30 y 86400.');
  }
  return {
    databaseUrl: env.DATABASE_URL, uploadDir: env.UPLOAD_DIR,
    proofDir: env.PROOF_DIR?.trim() || undefined,
    demoMode, port, assistedCapture, personalBrowser,
    autoSyncIntervalSeconds,
    host: env.HOST || '127.0.0.1',
    accountId: demoMode ? 'demo-local' : env.AULA_ACCOUNT_ID?.trim() || (assistedCapture || personalBrowser ? 'aula-unsa' : 'local'),
  };
}
