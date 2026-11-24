export interface RuntimeConfig {
  databaseUrl: string;
  uploadDir: string;
  host: string;
  port: number;
  demoMode: boolean;
  accountId: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  if (!env.DATABASE_URL || !env.UPLOAD_DIR) throw new Error('Configura DATABASE_URL y UPLOAD_DIR.');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT inválido.');
  const demoMode = env.NODE_ENV === 'development' && env.DEMO_MODE === 'true';
  return {
    databaseUrl: env.DATABASE_URL, uploadDir: env.UPLOAD_DIR, demoMode, port,
    host: env.HOST || '127.0.0.1', accountId: demoMode ? 'demo-local' : env.AULA_ACCOUNT_ID || 'local',
  };
}
